// Page behaviour: the download links (latest GitHub release, matched to the
// visitor's system), the nav, the marbled prints on each sheet, and the
// invoice demo. Everything works without this file; it only improves it.
(function () {
  "use strict";
  document.documentElement.classList.add("js");

  const RELEASES = "https://github.com/zParik/Qyra/releases/latest";
  const API = "https://api.github.com/repos/zParik/Qyra/releases/latest";
  const CACHE_KEY = "qyra-release-v1";

  // ── Which system is this? ─────────────────────────────────────────────
  function detectOS() {
    const ua = navigator.userAgent || "";
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return "phone";
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
    if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return "mac";
    if (/Linux|X11|CrOS/i.test(platform + " " + ua)) return "linux";
    return "unknown";
  }

  const ASSETS = {
    appimage: /\.AppImage$/i,
    deb: /\.deb$/i,
    rpm: /\.rpm$/i,
    msi: /\.msi$/i,
    exe: /-setup\.exe$/i,
  };

  function formatSize(bytes) {
    return bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    } catch (e) {
      return "";
    }
  }

  function readCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return Date.now() - data.at < 60 * 60 * 1000 ? data.release : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(release) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release }));
    } catch (e) { /* private mode: no cache */ }
  }

  async function latestRelease() {
    const cached = readCache();
    if (cached) return cached;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(API, { signal: ctrl.signal, headers: { Accept: "application/vnd.github+json" } });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const json = await res.json();
      const release = {
        tag: json.tag_name,
        date: json.published_at,
        assets: (json.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
      };
      writeCache(release);
      return release;
    } finally {
      clearTimeout(timer);
    }
  }

  function pick(release) {
    const found = {};
    for (const [key, re] of Object.entries(ASSETS)) {
      const asset = release.assets.find((a) => re.test(a.name));
      if (asset) found[key] = asset;
    }
    return found;
  }

  const os = detectOS();
  const primary = document.querySelector("[data-primary]");
  const primaryLabel = document.querySelector("[data-primary-label]");
  const primaryMeta = document.querySelector("[data-primary-meta]");
  const secondary = document.querySelector("[data-secondary]");

  function labelHero(assets) {
    const linux = assets.appimage;
    const windows = assets.msi || assets.exe;
    const set = (a, label, meta) => {
      if (a) primary.href = a.url;
      primaryLabel.textContent = label;
      primaryMeta.textContent = meta;
    };
    if (os === "windows") {
      set(windows, "Download for Windows", windows ? `${windows === assets.msi ? ".msi" : ".exe"} · ${formatSize(windows.size)}` : "installer");
      secondary.textContent = "Linux and other files";
    } else if (os === "linux") {
      set(linux, "Download for Linux", linux ? `AppImage · ${formatSize(linux.size)}` : "AppImage");
      secondary.textContent = "Windows, .deb, .rpm";
    } else {
      // A Mac or a phone: Qyra runs on neither, so send them to the full list.
      primary.href = "#download";
      primaryLabel.textContent = "Get it for your PC";
      primaryMeta.textContent = os === "mac" ? "Linux and Windows only" : "for Linux and Windows";
      secondary.textContent = "See all installers";
    }
  }

  function fillDownloads(release, assets) {
    document.querySelectorAll("[data-asset]").forEach((link) => {
      const asset = assets[link.dataset.asset];
      if (!asset) return;
      link.href = asset.url;
      const size = link.querySelector("[data-size]");
      if (size) size.textContent = formatSize(asset.size);
    });
    const date = formatDate(release.date);
    document.querySelectorAll("[data-version]").forEach((el) => { el.textContent = release.tag; });
    document.querySelectorAll("[data-version-long]").forEach((el) => {
      el.textContent = date ? `Qyra ${release.tag}, released ${date}` : `Qyra ${release.tag}`;
    });
  }

  const mine = document.querySelector(`.dl-os[data-os="${os}"]`);
  if (mine) mine.classList.add("is-yours");
  labelHero({});

  latestRelease()
    .then((release) => {
      const assets = pick(release);
      labelHero(assets);
      fillDownloads(release, assets);
    })
    .catch(() => {
      // Links already point at the GitHub release page; say so plainly.
      document.querySelectorAll("[data-size]").forEach((el) => { el.textContent = "on GitHub"; });
      if (os === "windows" || os === "linux") primary.href = RELEASES;
    });

  // ── Nav turns solid once the basin is behind it ───────────────────────
  const nav = document.getElementById("nav");
  const basin = document.querySelector(".basin");
  if (nav && basin) {
    new IntersectionObserver(([entry]) => {
      nav.classList.toggle("is-solid", !entry.isIntersecting);
    }, { rootMargin: "-64px 0px 0px 0px" }).observe(basin);
  }

  // ── The hint fades after the first touch of the water ─────────────────
  if (basin) {
    const touched = () => basin.classList.add("is-touched");
    basin.addEventListener("pointerdown", touched, { once: true });
  }

  // ── Prints: the basin's settled pattern on every sheet's top edge ─────
  let lastPrint = null;
  document.addEventListener("basin:print", (e) => {
    document.documentElement.style.setProperty("--print", `url("${e.detail}")`);
    document.body.classList.add("has-print");
    if (lastPrint && lastPrint.startsWith("blob:")) URL.revokeObjectURL(lastPrint);
    lastPrint = e.detail;
  });

  // ── Sheets settle in once as they enter ───────────────────────────────
  const sheets = document.querySelectorAll(".sheet");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -10% 0px" });
    sheets.forEach((s) => io.observe(s));
  } else {
    sheets.forEach((s) => s.classList.add("is-in"));
  }

  // ── The invoice demo ──────────────────────────────────────────────────
  const tools = document.querySelectorAll("[data-tool]");
  const status = document.querySelector("[data-window-status]");
  const sign = document.querySelector("[data-sign-line]");
  const messages = {
    highlight: "Highlight is on. Click a line on the invoice.",
    redact: "Redact is on. Click a line to black it out. In Qyra the text underneath is removed, not just covered.",
    sign: "Sign is on. Click the signature line.",
  };
  let tool = "highlight";

  tools.forEach((button) => {
    button.addEventListener("click", () => {
      tool = button.dataset.tool;
      tools.forEach((b) => {
        const on = b === button;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      if (status) status.textContent = messages[tool];
    });
  });

  document.querySelectorAll("[data-line]").forEach((line) => {
    line.addEventListener("click", () => {
      if (tool === "highlight") {
        line.classList.toggle("is-highlight");
        if (status) status.textContent = line.classList.contains("is-highlight") ? "Highlighted. Saved into the PDF, so every other viewer shows it too." : messages.highlight;
      } else if (tool === "redact") {
        line.classList.add("is-redact");
        if (status) status.textContent = "Redacted.";
      } else {
        if (status) status.textContent = "Pick Sign, then click the signature line.";
      }
    });
  });

  if (sign) {
    sign.addEventListener("click", () => {
      if (tool !== "sign") {
        if (status) status.textContent = "Pick Sign in the toolbar first.";
        return;
      }
      sign.classList.add("is-signed");
      sign.querySelector(".sig-label").textContent = "Signed";
      if (status) status.textContent = "Signed. Drawn into the page when you save, upright on any page rotation.";
    });
  }

  const reset = document.querySelector("[data-reset]");
  if (reset) {
    reset.addEventListener("click", () => {
      document.querySelectorAll("[data-line]").forEach((l) => l.classList.remove("is-highlight", "is-redact"));
      if (sign) {
        sign.classList.remove("is-signed");
        sign.querySelector(".sig-label").textContent = "Sign here";
      }
      if (status) status.textContent = messages[tool];
    });
  }
})();
