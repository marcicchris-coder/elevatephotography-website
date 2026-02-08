const yearEl = document.getElementById("year");
const gallery = document.getElementById("gallery");
const lightbox = document.getElementById("lightbox");
const lightboxImage = document.getElementById("lightboxImage");
const lightboxCaption = document.getElementById("lightboxCaption");
const closeLightbox = document.getElementById("closeLightbox");
const siteLinks = window.SITE_LINKS || {};
const configuredApiBase = String(siteLinks.api_base || "").trim().replace(/\/$/, "");

function isLocalHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function getApiBase() {
  // Avoid mixed-content blocks when site is HTTPS and config points to HTTP API.
  if (configuredApiBase) {
    const isInsecure = configuredApiBase.startsWith("http://");
    const pageIsSecure = window.location.protocol === "https:";
    if (!(isInsecure && pageIsSecure)) {
      return configuredApiBase;
    }
  }

  // Local development fallback when no valid configured base is usable.
  if (isLocalHost(window.location.hostname)) {
    return "http://127.0.0.1:8788";
  }

  // Hosted fallback: use same-origin API path.
  return "";
}

const apiBase = getApiBase();

function apiUrl(pathnameAndQuery) {
  if (apiBase) return `${apiBase}${pathnameAndQuery}`;
  return pathnameAndQuery;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(iso) {
  if (!iso) return "Schedule pending";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Schedule pending";
  return parsed.toLocaleString();
}

function formatLocationLabel(address) {
  if (!address) return "View Photos";
  const parts = String(address).split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length) {
    for (let index = 0; index < parts.length; index += 1) {
      const zipMatch = parts[index].match(/\b\d{5}(?:-\d{4})?\b/);
      if (zipMatch) {
        const city = parts[index - 1] || parts[index] || "Location";
        return `${city}, ${zipMatch[0]}`;
      }
    }
  }
  return String(address);
}

const linkNodes = [...document.querySelectorAll("[data-link-key]")];
if (linkNodes.length) {
  linkNodes.forEach((node) => {
    const key = node.dataset.linkKey;
    const href = siteLinks[key];
    if (!href) return;

    node.setAttribute("href", href);
    if (href.startsWith("http")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

const embedNodes = [...document.querySelectorAll("[data-embed-key]")];
if (embedNodes.length) {
  embedNodes.forEach((node) => {
    const key = node.dataset.embedKey;
    const src = siteLinks[key];
    if (!src) return;
    node.setAttribute("src", src);
  });
}

if (yearEl) {
  yearEl.textContent = new Date().getFullYear();
}

if (gallery && lightbox && lightboxImage && lightboxCaption) {
  gallery.addEventListener("click", (event) => {
    const img = event.target.closest("img");
    if (!img) return;

    const caption = img.closest("figure")?.querySelector("figcaption")?.textContent ?? "";
    lightboxImage.src = img.src;
    lightboxImage.alt = img.alt;
    lightboxCaption.textContent = caption;
    lightbox.showModal();
  });
}

if (closeLightbox && lightbox) {
  closeLightbox.addEventListener("click", () => {
    lightbox.close();
  });

  lightbox.addEventListener("click", (event) => {
    const insideImage = event.target.closest("img") || event.target.closest("button");
    if (!insideImage) {
      lightbox.close();
    }
  });
}

const shootGrid = document.getElementById("shootGrid");
const shootsStatus = document.getElementById("shootsStatus");

if (shootGrid && shootsStatus) {
  fetch(apiUrl("/api/shoots?limit=24"))
    .then(async (response) => {
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || `API request failed (${response.status})`);
      }
      return payload;
    })
    .then((payload) => {
      const shoots = payload.shoots || [];
      if (!shoots.length) {
        shootsStatus.textContent = "No shoots found yet.";
        return;
      }

      shootsStatus.textContent = `${shoots.length} shoots loaded.`;
      shootGrid.innerHTML = shoots.map((shoot) => {
        const thumb = shoot.thumbnail_url
          ? `<img class="shoot-thumb" src="${escapeHtml(shoot.thumbnail_url)}" alt="${escapeHtml(shoot.address)}" loading="lazy" />`
          : `<div class="shoot-thumb"></div>`;
        const photoThumbs = Array.isArray(shoot.photos) ? shoot.photos.slice(0, 8) : [];
        const photoGrid = photoThumbs.length
          ? `<div class="shoot-photos">${photoThumbs.map((url) => `<img class="shoot-photo" src="${escapeHtml(url)}" alt="${escapeHtml(shoot.address)} photo" loading="lazy" />`).join("")}</div>`
          : "";
        const titleLabel = formatLocationLabel(shoot.address || "Property");
        const detailHref = `shoot.html?order_id=${encodeURIComponent(shoot.id)}&label=${encodeURIComponent(titleLabel)}`;

        return `
          <article class="shoot-card">
            ${thumb}
            <div class="shoot-body">
              <h3><a class="shoot-title-link" href="${detailHref}">${escapeHtml(titleLabel)}</a></h3>
              ${photoGrid}
            </div>
          </article>
        `;
      }).join("");

      // Remove broken images so failed URLs do not show broken placeholders.
      shootGrid.querySelectorAll("img.shoot-thumb, img.shoot-photo").forEach((img) => {
        img.addEventListener("error", () => {
          img.remove();
        }, { once: true });
      });
    })
    .catch((error) => {
      shootsStatus.textContent = `Could not load shoots: ${error.message}`;
    });
}

const orderStatusForm = document.getElementById("orderStatusForm");
const orderStatusMessage = document.getElementById("orderStatusMessage");

if (orderStatusForm && orderStatusMessage) {
  orderStatusForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(orderStatusForm);
    const orderId = String(formData.get("order_id") || "").trim();
    if (!orderId) return;

    orderStatusMessage.textContent = "Checking status...";

    try {
      const response = await fetch(apiUrl(`/api/order-status?order_id=${encodeURIComponent(orderId)}`));
      const payload = await response.json();

      if (!response.ok) {
        orderStatusMessage.textContent = payload.error || "Unable to look up that order ID.";
        return;
      }

      orderStatusMessage.textContent = `Order ${payload.order_id}: ${payload.status} | ${payload.address} | ${formatDate(payload.scheduled_at)}`;
    } catch (error) {
      orderStatusMessage.textContent = `Status check failed: ${error.message}`;
    }
  });
}

const leadPipelineList = document.getElementById("leadPipelineList");
if (leadPipelineList) {
  fetch(apiUrl("/api/pipeline/leads?limit=12"))
    .then(async (response) => {
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || `API request failed (${response.status})`);
      }
      return payload;
    })
    .then((payload) => {
      const events = payload.events || [];
      if (!events.length) {
        leadPipelineList.innerHTML = "<p class=\"hero-copy\">No webhook events captured yet.</p>";
        return;
      }

      leadPipelineList.innerHTML = events.map((event) => `
        <article class="pipeline-item">
          <p><strong>${escapeHtml(event.event_type || "event")}</strong></p>
          <p>Order: ${escapeHtml(event.order_id || "n/a")}</p>
          <p>Status: ${escapeHtml(event.status || "n/a")}</p>
          <p>Address: ${escapeHtml(event.address || "n/a")}</p>
          <p>Captured: ${escapeHtml(formatDate(event.received_at))}</p>
        </article>
      `).join("");
    })
    .catch((error) => {
      leadPipelineList.innerHTML = `<p class=\"hero-copy\">Unable to load pipeline feed: ${escapeHtml(error.message)}</p>`;
    });
}

const shootDetailTitle = document.getElementById("shootTitle");
const shootDetailStatus = document.getElementById("shootDetailStatus");
const shootDetailGrid = document.getElementById("shootDetailGrid");

if (shootDetailTitle && shootDetailStatus && shootDetailGrid) {
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get("order_id");
  const fallbackLabel = params.get("label") || "Shoot";

  shootDetailTitle.textContent = fallbackLabel;

  if (!orderId) {
    shootDetailStatus.textContent = "Missing order ID.";
  } else {
    fetch(apiUrl(`/api/shoot?order_id=${encodeURIComponent(orderId)}`))
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error || `API request failed (${response.status})`);
        }
        return payload;
      })
      .then((payload) => {
        if (!payload?.shoot) {
          shootDetailStatus.textContent = "Shoot details not found.";
          return;
        }

        const shoot = payload.shoot;
        const titleLabel = formatLocationLabel(shoot.address || fallbackLabel);
        const photos = Array.isArray(shoot.photos) ? shoot.photos : [];

        shootDetailTitle.textContent = titleLabel;
        if (!photos.length) {
          shootDetailStatus.textContent = "No photos are available for this shoot yet.";
          return;
        }

        shootDetailStatus.textContent = `${photos.length} photos loaded.`;
        shootDetailGrid.innerHTML = photos.map((url) => `
          <img class="shoot-detail-photo" src="${escapeHtml(url)}" alt="${escapeHtml(titleLabel)} photo" loading="lazy" />
        `).join("");
      })
      .catch((error) => {
        shootDetailStatus.textContent = `Could not load shoot photos: ${error.message}`;
      });
  }
}
