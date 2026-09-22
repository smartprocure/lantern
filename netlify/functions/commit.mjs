// Commits a dashboard HTML file (and optionally an updated root index.html
// with a new DASHBOARDS registry entry) to GitHub via the Contents API.
// Or deletes a dashboard. Hides GITHUB_TOKEN server-side.
//
// Auth: every request must include { auth: { email, password } } in the body.
// email must be in STUDIO_ADMINS (csv); password must equal STUDIO_ADMIN_PASSWORD.

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const env = process.env;
  const missing = [];
  if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!env.GITHUB_REPO) missing.push("GITHUB_REPO");
  if (!env.STUDIO_ADMINS) missing.push("STUDIO_ADMINS");
  if (!env.STUDIO_ADMIN_PASSWORD) missing.push("STUDIO_ADMIN_PASSWORD");
  if (missing.length) {
    return json({ error: `Missing env vars: ${missing.join(", ")}` }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const action = body.action || "ship";

  // ---- Auth gate (applies to every action) ---------------------------------
  // Human studio admins use email + STUDIO_ADMIN_PASSWORD.
  // The data pipeline uses a dedicated PIPELINE_SECRET token so it doesn't
  // share the human admin password.
  const pipelineToken = String(body?.auth?.token || "");
  const isPipelineAuth =
    env.PIPELINE_SECRET &&
    pipelineToken.length > 0 &&
    pipelineToken === env.PIPELINE_SECRET &&
    action === "data"; // pipeline token is only accepted for the data action

  const email = String(body?.auth?.email || "").trim().toLowerCase();
  const password = String(body?.auth?.password || "");
  const admins = env.STUDIO_ADMINS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const isHumanAuth = email && admins.includes(email) && password === env.STUDIO_ADMIN_PASSWORD;

  if (!isPipelineAuth && !isHumanAuth) {
    return json({ error: "Not authorized" }, 401);
  }

  // ---- auth-check: just confirm creds, do nothing --------------------------
  if (action === "auth-check") {
    return json({ ok: true, email });
  }

  // ---- Common GitHub helpers ----------------------------------------------
  const repo = env.GITHUB_REPO;
  const headers = {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "studio-commit",
  };
  const ghBase = `https://api.github.com/repos/${repo}/contents`;

  async function getSha(path) {
    const res = await fetch(`${ghBase}/${path}?ref=main`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
    return (await res.json()).sha;
  }

  async function putFile(path, content, message, sha, isBase64 = false) {
    const payload = {
      message,
      content: isBase64 ? content : utf8ToBase64(content),
      branch: "main",
    };
    if (sha) payload.sha = sha;
    const res = await fetch(`${ghBase}/${path}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`PUT ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async function deleteFile(path, message, sha) {
    const res = await fetch(`${ghBase}/${path}`, {
      method: "DELETE",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ message, sha, branch: "main" }),
    });
    if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async function getFileText(path) {
    const res = await fetch(`${ghBase}/${path}?ref=main`, { headers });
    if (res.status === 404) return { sha: null, text: null };
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
    const j = await res.json();
    const text = j.content ? Buffer.from(j.content, "base64").toString("utf-8") : "";
    return { sha: j.sha, text };
  }

  // Upsert (patch != null) or remove (patch == null) a slug in the private
  // registry JSON, server-side, so the gated file never has to be read by the
  // browser. Returns the commit sha.
  async function writePrivateRegistry(slug, patch, email) {
    const path = "private/dashboards.json";
    const { sha, text } = await getFileText(path);
    let list = [];
    if (text) {
      try { list = JSON.parse(text); } catch { list = []; }
    }
    if (!Array.isArray(list)) list = [];
    const existing = list.find((d) => d && d.slug === slug) || {};
    let next = list.filter((d) => d && d.slug !== slug);
    if (patch !== null) {
      next.push({
        slug,
        title: (patch.title && patch.title.trim()) || existing.title || slug,
        description: (patch.description && patch.description.trim()) || existing.description || "",
        updated: new Date().toISOString().slice(0, 10),
      });
    }
    next.sort((a, b) => String(a.title || a.slug).localeCompare(String(b.title || b.slug)));
    const res = await putFile(
      path,
      JSON.stringify(next, null, 2) + "\n",
      `${patch ? "Register" : "Unregister"} ${slug} in private registry (by ${email})`,
      sha,
    );
    return res.commit?.sha || null;
  }

  // ---- Validate slug (used by both ship and delete) ------------------------
  const slug = body.slug;
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return json({ error: "slug must be kebab-case (a-z, 0-9, hyphens)" }, 400);
  }

  // Private space: dashboards live under private/<slug>/ and are listed in
  // private/dashboards.json (a JSON registry) instead of the public landing
  // page. `prefix` is a constant derived from a boolean — no traversal risk.
  const isPrivate = body.private === true;
  const prefix = isPrivate ? "private/" : "";

  // ---- DELETE action -------------------------------------------------------
  if (action === "delete") {
    if (!isPrivate && typeof body.updatedIndexHtml !== "string") {
      return json({ error: "delete requires updatedIndexHtml (registry entry removed)" }, 400);
    }
    try {
      const dashboardPath = `${prefix}${slug}/index.html`;
      const dashSha = await getSha(dashboardPath);
      if (!dashSha) return json({ error: `Dashboard "${slug}" does not exist on main` }, 404);

      const delMsg = `Delete ${isPrivate ? "private " : ""}${slug} dashboard via Studio (by ${email})`;
      const delRes = await deleteFile(dashboardPath, delMsg, dashSha);

      let indexCommitSha = null;
      if (isPrivate) {
        indexCommitSha = await writePrivateRegistry(slug, null, email);
      } else {
        const indexSha = await getSha("index.html");
        if (!indexSha) throw new Error("Root index.html not found");
        const indexRes = await putFile(
          "index.html",
          body.updatedIndexHtml,
          `Unregister ${slug} from DASHBOARDS (by ${email})`,
          indexSha,
        );
        indexCommitSha = indexRes.commit?.sha || null;
      }

      return json({
        ok: true,
        deletedCommitSha: delRes.commit?.sha || null,
        indexCommitSha,
      });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // ---- EDIT META action ---------------------------------------------------
  if (action === 'edit-meta') {
    const patch = body.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return json({ error: 'edit-meta requires a patch object' }, 400);
    }
    try {
      if (isPrivate) {
        const commitSha = await writePrivateRegistry(slug, patch, email);
        return json({ ok: true, commitSha });
      }
      const { sha, text } = await getFileText('index.html');
      if (!sha) throw new Error('Root index.html not found');
      const updated = patchRegistryEntry(text, slug, patch);
      if (!updated) return json({ error: `Dashboard "${slug}" not found in DASHBOARDS` }, 404);
      const res = await putFile(
        'index.html',
        updated,
        `Update ${slug} metadata (by ${email})`,
        sha,
      );
      return json({ ok: true, commitSha: res.commit?.sha || null });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // ---- DATA action — pipeline commits data files --------------------------
  // Body: { action:'data', auth, slug, files:[{name, content}] }
  // Commits each file at <slug>/<name> on main. The slug is already validated
  // above. File names follow the same rules as dataFiles in the ship action.
  if (action === 'data') {
    const files = body.files;
    if (!Array.isArray(files) || files.length === 0) {
      return json({ error: 'data action requires a non-empty files array' }, 400);
    }
    const ALLOWED_EXT = new Set([
      'json', 'csv', 'tsv', 'txt', 'geojson', 'svg', 'md', 'js', 'mjs', 'css', 'pdf',
    ]);
    const clean = [];
    for (const f of files) {
      const name = String(f?.name || '').trim();
      if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) || name.split('/').includes('..')) {
        return json({ error: `Invalid file name: ${JSON.stringify(f?.name)}` }, 400);
      }
      const ext = name.split('.').pop().toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        return json({ error: `File "${name}" must end in: ${[...ALLOWED_EXT].join(', ')}` }, 400);
      }
      if (typeof f.content !== 'string') {
        return json({ error: `File "${name}" content must be a string` }, 400);
      }
      clean.push({ name, content: f.content });
    }
    try {
      const commits = [];
      const actor = email || 'pipeline';
      for (const f of clean) {
        const path = `${slug}/${f.name}`;
        const sha  = await getSha(path);
        const res  = await putFile(
          path,
          f.content,
          `Update ${path} via pipeline (by ${actor})`,
          sha,
        );
        commits.push({ path, commitSha: res.commit?.sha || null });
      }
      return json({ ok: true, commitSha: commits[0]?.commitSha || null, files: commits });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  // ---- SHIP action (default) ----------------------------------------------
  const { html, commitMessage, isNew, updatedIndexHtml, dataFiles } = body;
  if (typeof html !== "string" || !html.includes("<html") || !html.includes("</html>")) {
    return json({ error: "html must be a complete HTML document" }, 400);
  }
  if (!isPrivate && isNew && typeof updatedIndexHtml !== "string") {
    return json({ error: "isNew requires updatedIndexHtml" }, 400);
  }

  // Optional companion files committed into the dashboard folder alongside
  // index.html (e.g. a data.json the HTML fetches, or a sibling app.js/styles.css).
  // Text only — putFile base64-encodes UTF-8, which would corrupt binary formats.
  const ALLOWED_DATA_EXT = new Set([
    "json", "csv", "tsv", "txt", "geojson", "svg", "md", "js", "mjs", "css", "pdf",
  ]);
  const cleanDataFiles = [];
  if (dataFiles != null) {
    if (!Array.isArray(dataFiles)) {
      return json({ error: "dataFiles must be an array" }, 400);
    }
    for (const f of dataFiles) {
      const name = String(f?.name || "").trim();
      // Relative path under the dashboard folder: no leading slash, no traversal.
      if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) || name.split("/").includes("..")) {
        return json({ error: `Invalid data file name: ${JSON.stringify(f?.name)}` }, 400);
      }
      const ext = name.split(".").pop().toLowerCase();
      if (!ALLOWED_DATA_EXT.has(ext)) {
        return json({ error: `Data file "${name}" must end in one of: ${[...ALLOWED_DATA_EXT].join(", ")}` }, 400);
      }
      if (typeof f.content !== "string") {
        return json({ error: `Data file "${name}" content must be a string` }, 400);
      }
      cleanDataFiles.push({ name, content: f.content, binary: !!f.binary });
    }
  }

  try {
    const dashboardPath = `${prefix}${slug}/index.html`;
    const existingSha = await getSha(dashboardPath);

    if (isNew && existingSha) {
      return json(
        { error: `Dashboard slug "${slug}" already exists. Pick a new slug or update the existing one.` },
        409,
      );
    }

    const baseMsg = commitMessage || (existingSha ? `Update ${slug} dashboard` : `Add ${slug} dashboard`);
    const dashboardMsg = `${baseMsg}${isPrivate ? " (private)" : ""} via Studio (by ${email})`;
    const dashRes = await putFile(dashboardPath, html, dashboardMsg, existingSha);

    // Commit each companion data file into the dashboard folder.
    const dataCommits = [];
    for (const df of cleanDataFiles) {
      const dfPath = `${prefix}${slug}/${df.name}`;
      const dfSha = await getSha(dfPath);
      const dfRes = await putFile(
        dfPath,
        df.content,
        `${dfSha ? "Update" : "Add"} ${dfPath} via Studio (by ${email})`,
        dfSha,
        df.binary,
      );
      dataCommits.push({ path: dfPath, commitSha: dfRes.commit?.sha || null });
    }

    // Register the dashboard: private ones in the JSON registry (server-side),
    // public ones in the landing-page HTML the client computed.
    let indexCommitSha = null;
    if (isPrivate) {
      indexCommitSha = await writePrivateRegistry(slug, body.registryEntry || {}, email);
    } else if (isNew) {
      const indexSha = await getSha("index.html");
      if (!indexSha) throw new Error("Root index.html not found — cannot register dashboard");
      const indexRes = await putFile(
        "index.html",
        updatedIndexHtml,
        `Register ${slug} in DASHBOARDS (by ${email})`,
        indexSha,
      );
      indexCommitSha = indexRes.commit?.sha || null;
    }

    return json({
      ok: true,
      commitSha: dashRes.commit?.sha || null,
      indexCommitSha,
      dataFiles: dataCommits,
      deployUrl: `https://govspend-ops-dashboards.netlify.app/${prefix}${slug}/`,
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
};

function patchRegistryEntry(indexHtml, slug, patch) {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idPattern = new RegExp(`id:\\s*["']${escaped}["']`);
  const idxOfId = indexHtml.search(idPattern);
  if (idxOfId === -1) return null;

  let openIdx = indexHtml.lastIndexOf('{', idxOfId);
  if (openIdx === -1) return null;

  let depth = 0, i = openIdx, inString = false, stringChar = '';
  for (; i < indexHtml.length; i++) {
    const ch = indexHtml[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const closeEnd = i;

  let current;
  try {
    // eslint-disable-next-line no-new-func
    current = new Function(`return ${indexHtml.slice(openIdx, closeEnd)};`)();
  } catch {
    return null;
  }

  const merged = Object.assign({}, current, patch);
  const block = `{\n` +
    `    id: ${JSON.stringify(String(merged.id || slug))},\n` +
    `    title: ${JSON.stringify(String(merged.title || slug))},\n` +
    `    description: ${JSON.stringify(String(merged.description || ''))},\n` +
    `    section: ${JSON.stringify(String(merged.section || 'operational'))},\n` +
    `    href: ${JSON.stringify(String(merged.href || `/${slug}/`))},\n` +
    `    owner: ${JSON.stringify(String(merged.owner || ''))},\n` +
    `    cadence: ${JSON.stringify(String(merged.cadence || 'weekly'))},\n` +
    `    updated: ${JSON.stringify(String(merged.updated || 'today'))},\n` +
    `  }`;

  return indexHtml.slice(0, openIdx) + block + indexHtml.slice(closeEnd);
}

function utf8ToBase64(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
