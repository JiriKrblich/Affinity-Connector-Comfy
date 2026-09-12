// Your own ComfyUI workflow, run on what is in the document.
//
// ComfyUI already has everything: the models, the samplers, the graph somebody
// spent an evening wiring up. What it does not have is the document. So this
// connector is a courier — take the selection over, run the graph the person
// already built, bring the picture back to the exact place it came from — and
// deliberately not a second front end for ComfyUI.
//
// The server takes a workflow in "API format", which is what Workflow, Export
// (API) writes: an object keyed by node id, each node carrying a class_type and
// an inputs object, where a wire reads as [sourceNodeId, slot].
//
//   POST /prompt          { prompt, client_id } -> { prompt_id }
//   GET  /history/<id>    -> { <id>: { outputs: { <node>: { images: [...] } } } }
//   GET  /view?filename=&subfolder=&type=  -> the bytes
//   POST /upload/image    multipart -> { name, subfolder, type }
//
// Nothing here leaves the machine ComfyUI is on.
const fs = require("node:fs/promises");
const path = require("node:path");

// Which node is the prompt, which is the image, which holds the seed. A title
// wins over anything worked out, because somebody who titled a node meant it.
const TITLES = {
  prompt: ["prompt", "positive", "positive prompt"],
  negative: ["negative", "negative prompt"],
  image: ["image", "input", "input image"],
  seed: ["seed"],
};

function titled(workflow, which) {
  const wanted = TITLES[which];
  for (const [id, node] of Object.entries(workflow)) {
    const title = String((node._meta && node._meta.title) || "").trim().toLowerCase();
    if (title && wanted.includes(title)) return id;
  }
  return null;
}

// A wire is [nodeId, slot]. Anything else is a plain value somebody typed.
function wiredTo(node, name) {
  const value = node.inputs && node.inputs[name];
  return Array.isArray(value) && value.length === 2 ? String(value[0]) : null;
}

function nodesOf(workflow, classType) {
  return Object.entries(workflow)
    .filter(([, node]) => String(node.class_type || "") === classType)
    .map(([id]) => id);
}

// Everything the connector needs to change, found once.
function readGraph(workflow) {
  const found = {
    prompt: titled(workflow, "prompt"),
    negative: titled(workflow, "negative"),
    image: titled(workflow, "image"),
    seed: titled(workflow, "seed"),
    sampler: null,
  };

  // The sampler knows which text node is positive and which negative, which is
  // the only way to tell them apart that does not involve guessing.
  for (const [id, node] of Object.entries(workflow)) {
    const inputs = node.inputs || {};
    const hasSeed = "seed" in inputs || "noise_seed" in inputs;
    if (!hasSeed && !("positive" in inputs && "negative" in inputs)) continue;
    found.sampler = found.sampler || id;
    if (!found.prompt) found.prompt = wiredTo(node, "positive");
    if (!found.negative) found.negative = wiredTo(node, "negative");
    if (!found.seed && hasSeed) found.seed = id;
  }

  // A graph with no sampler at all, or one wired through a guider: fall back to
  // the text nodes in the order they were written.
  if (!found.prompt) {
    const text = Object.entries(workflow)
      .filter(([, node]) => (node.inputs || {}).text !== undefined && typeof node.inputs.text === "string")
      .map(([id]) => id);
    found.prompt = text[0] || null;
    if (!found.negative && text.length > 1) found.negative = text[1];
  }
  if (!found.image) found.image = nodesOf(workflow, "LoadImage")[0] || null;

  return found;
}

// A multipart body, by hand. ComfyUI's upload takes nothing else, and the two
// lines it costs are cheaper than a dependency.
function multipart(filename, bytes, fields = {}) {
  const boundary = `----connector${Math.random().toString(36).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  parts.push(bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  options: {
    // Whatever is in the workflows folder. Read straight off the disk rather
    // than from ComfyUI, because the server does not keep a list of them.
    async workflows(ctx) {
      const folder = String((ctx.settings && ctx.settings.workflows) || "").trim();
      if (!folder) return [];
      const entries = await fs.readdir(folder).catch(() => []);
      return entries
        .filter((name) => name.toLowerCase().endsWith(".json"))
        .sort()
        .map((name) => ({ value: name, label: name.replace(/\.json$/i, "") }));
    },
  },

  async run(ctx) {
    const address = String((ctx.settings && ctx.settings.address) || "http://127.0.0.1:8188")
      .trim()
      .replace(/\/+$/, "");
    const folder = String((ctx.settings && ctx.settings.workflows) || "").trim();
    if (!folder) {
      throw new Error(
        "Point this connector at a folder of workflows under Settings first. They have to be saved from ComfyUI with Workflow, Export (API).",
      );
    }

    const chosen = String(ctx.input.workflow || "").trim();
    if (!chosen) throw new Error("Choose a workflow.");
    // The name comes from a list this connector wrote, but it arrives as text,
    // so it is treated as text: a name, not a path.
    if (chosen.includes("/") || chosen.includes("\\") || chosen.includes("..")) {
      throw new Error(`"${chosen}" is not a workflow in that folder.`);
    }

    const file = path.join(folder, chosen);
    const raw = await fs.readFile(file, "utf8").catch(() => null);
    if (raw === null) throw new Error(`There is no ${chosen} in ${folder}.`);

    let workflow;
    try {
      workflow = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${chosen} is not valid JSON: ${err.message}`);
    }
    // The ordinary Save writes { nodes: [...], links: [...] }, which the server
    // rejects with a message about nothing in particular.
    if (workflow.nodes || workflow.links) {
      throw new Error(
        `${chosen} was saved with Workflow, Save. The server only takes the API shape — save it again with Workflow, Export (API).`,
      );
    }

    // Is it even there? A refused connection is worth saying plainly, because
    // the usual reason is that ComfyUI is not running.
    const alive = await ctx.http.get(`${address}/system_stats`).catch(() => null);
    if (!alive || !alive.ok) {
      throw new Error(
        `Nothing answered at ${address}. Start ComfyUI, or change the address under Settings.`,
      );
    }

    const graph = readGraph(workflow);
    const notes = [];

    // The picture, if the workflow loads one and something was chosen.
    const source = ctx.input.image;
    if (graph.image && source && source.path) {
      ctx.progress("Sending the artwork to ComfyUI");
      const bytes = await ctx.files.read(source.path);
      const name = `affinity-${Date.now()}${path.extname(source.filename || ".png") || ".png"}`;
      const form = multipart(name, bytes, { overwrite: "true", type: "input" });
      const upload = await ctx.http(`${address}/upload/image`, {
        method: "POST",
        headers: { "Content-Type": form.type },
        body: form.body,
      });
      if (!upload.ok) {
        throw new Error(
          `ComfyUI would not take the artwork (HTTP ${upload.status}). ${(upload.text || "").slice(0, 200)}`,
        );
      }
      const named = (upload.data && upload.data.name) || name;
      workflow[graph.image].inputs.image = named;
      ctx.log(`Uploaded ${named}, ${Math.round(bytes.length / 1024)} KB`);
    } else if (graph.image && !(source && source.path)) {
      notes.push("the workflow loads an image and none was chosen, so it kept its own");
    } else if (!graph.image && source && source.path) {
      notes.push("this workflow does not load an image, so the selection was not used");
    }

    // The words.
    const prompt = String(ctx.input.prompt || "").trim();
    if (prompt) {
      if (!graph.prompt) {
        throw new Error(
          `No text node in ${chosen} to put the prompt in. Title one “prompt” in ComfyUI and export it again.`,
        );
      }
      workflow[graph.prompt].inputs.text = prompt;
    }
    const negative = String(ctx.input.negative || "").trim();
    if (negative && graph.negative) workflow[graph.negative].inputs.text = negative;
    else if (negative) notes.push("there is no negative text node in this workflow");

    // The seed. A workflow run twice with the same seed gives the same picture,
    // which is rarely what somebody pressing the button again wants.
    if (graph.seed) {
      const asked = String(ctx.input.seed || "").trim();
      const seed = asked ? Number(asked) : Math.floor(Math.random() * 2 ** 48);
      if (!Number.isFinite(seed)) throw new Error(`"${asked}" is not a seed.`);
      const inputs = workflow[graph.seed].inputs;
      if ("seed" in inputs) inputs.seed = seed;
      else if ("noise_seed" in inputs) inputs.noise_seed = seed;
      ctx.log(`Seed ${seed}`);
    }

    // Queue it.
    const clientId = `connector-${Math.random().toString(36).slice(2)}`;
    const queued = await ctx.http.postJson(`${address}/prompt`, {
      prompt: workflow,
      client_id: clientId,
    });
    if (!queued.ok) {
      const errors = queued.data && queued.data.node_errors;
      const first = errors && Object.values(errors)[0];
      const detail =
        (first && first.errors && first.errors[0] && first.errors[0].message) ||
        (queued.data && queued.data.error && queued.data.error.message) ||
        (queued.text || "").slice(0, 300);
      throw new Error(`ComfyUI refused the workflow (HTTP ${queued.status})${detail ? ": " + detail : ""}`);
    }
    const id = queued.data && queued.data.prompt_id;
    if (!id) throw new Error("ComfyUI took the workflow but did not say what it called it.");

    // Wait for it. There is a websocket that would say when each node finishes,
    // but asking the history every second costs nothing and cannot get stuck
    // half way through a socket that dropped.
    ctx.progress("ComfyUI is working");
    let outputs = null;
    const started = Date.now();
    const giveUp = Math.max(60, Number(ctx.app && ctx.app.timeoutSec) || 1800) * 1000 - 10000;
    while (!outputs) {
      await wait(1000);
      const history = await ctx.http.get(`${address}/history/${id}`).catch(() => null);
      const entry = history && history.data && history.data[id];
      if (entry && entry.status && entry.status.status_str === "error") {
        const message = (entry.status.messages || [])
          .map((m) => (Array.isArray(m) && m[1] && m[1].exception_message) || "")
          .filter(Boolean)[0];
        throw new Error(`The workflow failed in ComfyUI${message ? ": " + message : "."}`);
      }
      if (entry && entry.outputs && Object.keys(entry.outputs).length) outputs = entry.outputs;
      const waited = Math.round((Date.now() - started) / 1000);
      if (Date.now() - started > giveUp) {
        throw new Error(`ComfyUI has been working for ${waited} seconds. Giving up on it.`);
      }
      if (!outputs && waited % 5 === 0) ctx.progress(`ComfyUI is working, ${waited}s`);
    }

    // Everything it made.
    const made = [];
    for (const node of Object.values(outputs)) {
      for (const image of node.images || []) {
        if (String(image.type || "") === "temp") continue;
        const query = new URLSearchParams({
          filename: image.filename,
          subfolder: image.subfolder || "",
          type: image.type || "output",
        });
        const got = await ctx.http.download(`${address}/view?${query}`, {
          filename: image.filename,
        });
        made.push({ path: got.path, caption: image.filename });
      }
    }
    if (!made.length) {
      throw new Error(
        "The workflow finished without saving an image. It needs a Save Image node for anything to come back.",
      );
    }

    // Home again, to exactly where it came from — but only when there is one
    // of it. A workflow with a batch size of four makes four answers to the
    // same question, and stacking all four on the canvas answers it for you.
    if (ctx.input.place !== false) {
      const direct = ctx.input.__bridgeDirect === true;
      if (direct && made.length === 1) {
        await (source && source.path
          ? ctx.affinity.putBack(made[0].path, source)
          : ctx.affinity.placeImage(made[0].path, {}));
        ctx.progress("Placed in the document");
      } else if (direct && made.length > 1) {
        return {
          message: `${made.length} results ready to choose from`,
          __bridgeChoice: {
            question: "Which ComfyUI result?",
            paths: made.map((image) => image.path),
            options: made.map((_, i) => `Version ${i + 1}`),
            source,
          },
          images: made,
        };
      } else {
        const doc = await ctx.affinity.info();
        if (!doc.open) {
          ctx.log.warn("No document is open, so the pictures are waiting in the handover folder.");
        } else if (made.length === 1) {
          await (source && source.path
            ? ctx.affinity.putBack(made[0].path, source)
            : ctx.affinity.placeImage(made[0].path, {}));
          ctx.progress("Placed in the document");
        } else {
          ctx.log.warn(
            `${made.length} pictures came back, so none were placed. Look through them and place the one you want.`,
          );
        }
      }
    }

    for (const note of notes) ctx.log.warn(note.charAt(0).toUpperCase() + note.slice(1));
    return {
      message: `${made.length} image${made.length === 1 ? "" : "s"} from ${chosen.replace(/\.json$/i, "")}`,
      images: made,
    };
  },
};
