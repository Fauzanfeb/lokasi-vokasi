"use strict";

const STATUS = {
  working: "Berfungsi",
  review: "Dalam Verifikasi",
  broken: "Tidak Berfungsi",
  unavailable: "Tidak Tersedia",
};

const STATUS_CLASS = {
  [STATUS.working]: "status-working",
  [STATUS.review]: "status-review",
  [STATUS.broken]: "status-broken",
  [STATUS.unavailable]: "status-unavailable",
};

const REPORT_TYPES = [
  "Colokan rusak",
  "Colokan tidak berfungsi",
  "Stopkontak longgar",
  "Port USB tidak berfungsi",
  "Titik colokan sudah tidak tersedia",
  "Informasi lokasi tidak sesuai",
  "Menambahkan titik colokan baru",
];

const REPORT_STATUS = {
  pending: "Menunggu Verifikasi",
  approved: "Disetujui",
  rejected: "Ditolak",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let supabaseClient = null;
let locations = [];
let reports = [];
let activity = [];
let adminUser = null;
let realtimeChannel = null;
let activeAdminTab = "reports";
let activeReportFilter = "all";
let adminSearch = "";
let toastTimer;

function mapLocation(row) {
  const photo = row.photo_path
    ? supabaseClient.storage.from("location-photos").getPublicUrl(row.photo_path).data.publicUrl
    : "";
  return {
    id: row.id,
    building: row.building,
    floor: row.floor,
    area: row.area,
    position: row.position,
    outlets: row.outlets,
    ports: row.ports,
    status: row.status,
    verifiedAt: row.verified_at,
    category: row.category,
    art: row.art,
    photo,
    photoPath: row.photo_path,
  };
}

function mapReport(row) {
  return {
    id: row.id,
    locationId: row.location_id,
    newLocation: row.new_location,
    type: row.type,
    name: row.name,
    description: row.description,
    photoPath: row.photo_path,
    status: row.status,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
  };
}

async function loadRemoteData() {
  if (!supabaseClient) return;
  const locationResult = await supabaseClient.from("locations").select("*").order("building").order("id");
  if (locationResult.error) throw locationResult.error;
  locations = locationResult.data.map(mapLocation);

  if (adminUser) {
    const [reportResult, activityResult] = await Promise.all([
      supabaseClient.from("reports").select("*").order("created_at", { ascending: false }),
      supabaseClient.from("activity").select("*").order("timestamp", { ascending: false }).limit(50),
    ]);
    if (reportResult.error) throw reportResult.error;
    if (activityResult.error) throw activityResult.error;
    reports = reportResult.data.map(mapReport);
    activity = activityResult.data;
  } else {
    reports = [];
    activity = [];
  }
  refreshViews();
}

async function initializeBackend() {
  const config = window.LOKASI_SUPABASE_CONFIG;
  if (!window.supabase?.createClient || !config?.url || !config?.anonKey) {
    setBackendNotice("Backend belum dikonfigurasi. Isi URL dan anon key Supabase di supabase-config.js untuk memuat direktori.");
    return;
  }
  supabaseClient = window.supabase.createClient(config.url, config.anonKey);
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    if (data.session) {
      const { data: role, error: roleError } = await supabaseClient.rpc("is_admin");
      if (roleError) throw roleError;
      if (role) adminUser = data.session.user;
    }
    await loadRemoteData();
    $("#backend-notice").hidden = true;
    subscribeToChanges();
    if (adminUser) enterAdmin();
  } catch (error) {
    console.error("Tidak dapat memuat data dari Supabase.", error);
    setBackendNotice("Direktori belum dapat dimuat dari backend. Periksa konfigurasi dan koneksi Supabase.");
    showToast("Data backend gagal dimuat. Periksa koneksi dan konfigurasi Supabase.", true);
  }
}

function setBackendNotice(message) {
  const notice = $("#backend-notice");
  notice.textContent = message;
  notice.hidden = false;
}

function subscribeToChanges() {
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel = supabaseClient.channel("lokasi-live-updates")
    .on("postgres_changes", { event: "*", schema: "public", table: "locations" }, () => {
      loadRemoteData().catch((error) => {
        console.error("Sinkronisasi lokasi gagal.", error);
        showToast("Perubahan lokasi belum dapat disinkronkan.", true);
      });
    });
  if (adminUser) {
    realtimeChannel
      .on("postgres_changes", { event: "*", schema: "public", table: "reports" }, () => {
        loadRemoteData().catch((error) => {
          console.error("Sinkronisasi laporan gagal.", error);
          showToast("Perubahan laporan belum dapat disinkronkan.", true);
        });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "activity" }, () => {
        loadRemoteData().catch((error) => {
          console.error("Sinkronisasi aktivitas gagal.", error);
          showToast("Riwayat perubahan belum dapat disinkronkan.", true);
        });
      });
  }
  realtimeChannel.subscribe((status) => {
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      showToast("Koneksi sinkronisasi langsung terputus. Muat ulang halaman untuk mencoba lagi.", true);
    }
  });
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "id"));
}

function formatDate(value, options = { day: "numeric", month: "short", year: "numeric" }) {
  if (!value) return "Belum diverifikasi";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "Belum diverifikasi";
  return new Intl.DateTimeFormat("id-ID", options).format(date);
}

function statusPill(status, extraClass = "") {
  const knownStatus = Object.hasOwn(STATUS_CLASS, status) ? status : STATUS.working;
  return `<span class="status-pill ${STATUS_CLASS[knownStatus]} ${extraClass}">${escapeHTML(knownStatus)}</span>`;
}

function currentStatus(location) {
  const pendingReport = reports.some((report) => report.locationId === location.id && report.status === REPORT_STATUS.pending);
  return pendingReport ? STATUS.review : location.status;
}

function mapIllustration(location, detail = false) {
  if (location.photo && typeof location.photo === "string" && /^(https:\/\/|data:image\/)/.test(location.photo)) {
    return `<div class="spot-art uploaded-art"><img src="${escapeHTML(location.photo)}" alt="Foto lokasi ${escapeHTML(location.area)}" loading="lazy"></div>`;
  }
  const art = Number.isInteger(location.art) ? ((location.art - 1 + 6) % 6) + 1 : 1;
  return `<div class="spot-art art-${art}" aria-hidden="true"><div class="art-wall"></div><div class="art-floor"></div><div class="art-outlet"></div><span class="art-label">LOKASI VOKASI</span></div>`;
}

function renderStats() {
  const buildings = unique(locations.map((location) => location.building)).length;
  const working = locations.filter((location) => currentStatus(location) === STATUS.working).length;
  $("#stat-locations").textContent = String(locations.length).padStart(2, "0");
  $("#stat-buildings").textContent = String(buildings).padStart(2, "0");
  $("#stat-working").textContent = String(working).padStart(2, "0");
}

function renderFilterOptions() {
  const building = $("#building-filter");
  const floor = $("#floor-filter");
  const category = $("#category-filter");
  const status = $("#status-filter");
  const buildingValue = building.value;
  const floorValue = floor.value;
  const categoryValue = category.value;
  const statusValue = status.value;
  const buildings = unique(locations.map((location) => location.building));
  const floors = unique(locations.map((location) => location.floor));
  const categories = unique(locations.map((location) => location.category));
  building.innerHTML = `<option value="">Semua gedung</option>${buildings.map((item) => `<option value="${escapeHTML(item)}">${escapeHTML(item)}</option>`).join("")}`;
  floor.innerHTML = `<option value="">Semua lantai</option>${floors.map((item) => `<option value="${escapeHTML(item)}">${escapeHTML(item)}</option>`).join("")}`;
  building.value = buildings.includes(buildingValue) ? buildingValue : "";
  floor.value = floors.includes(floorValue) ? floorValue : "";
  category.innerHTML = `<option value="">Semua area</option>${categories.map((item) => `<option value="${escapeHTML(item)}">${escapeHTML(item)}</option>`).join("")}`;
  category.value = categories.includes(categoryValue) ? categoryValue : "";
  status.innerHTML = `<option value="">Semua status</option>${Object.values(STATUS).map((item) => `<option value="${escapeHTML(item)}">${escapeHTML(item)}</option>`).join("")}`;
  status.value = Object.values(STATUS).includes(statusValue) ? statusValue : "";
}

function cardMarkup(location) {
  const title = `${location.building} · ${location.floor}`;
  const portLabel = Array.isArray(location.ports) && location.ports.length ? location.ports.join(", ") : "Stopkontak listrik";
  return `<article class="location-card">
    <button class="card-image-button" type="button" data-action="open-detail" data-id="${escapeHTML(location.id)}" aria-label="Lihat detail ${escapeHTML(title)} di ${escapeHTML(location.area)}">
      ${mapIllustration(location)}
      ${statusPill(currentStatus(location), "card-status")}
    </button>
    <div class="card-body">
      <div class="card-building"><span>${escapeHTML(location.building)} · ${escapeHTML(location.floor)}</span><span class="card-category">${escapeHTML(location.category || "Area publik")}</span></div>
      <h3 class="card-title">${escapeHTML(location.area)}</h3>
      <div class="card-location"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M14 7.5c0 3.6-5 8-5 8S4 11.1 4 7.5a5 5 0 1 1 10 0Z"/><circle cx="9" cy="7.5" r="1.5"/></svg><span>${escapeHTML(location.position)}</span></div>
      <div class="card-footer"><span class="outlet-info"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M5 3v4m8-4v4M3 7h12v2a6 6 0 0 1-5 6v1H8v-1a6 6 0 0 1-5-6V7Z"/></svg>${escapeHTML(String(location.outlets || 0))} titik · ${escapeHTML(portLabel)}</span><button class="card-detail" type="button" data-action="open-detail" data-id="${escapeHTML(location.id)}">Detail <span aria-hidden="true">↗</span></button></div>
    </div>
  </article>`;
}

function renderLocations() {
  const query = $("#directory-search-input").value.trim().toLocaleLowerCase("id");
  const building = $("#building-filter").value;
  const floor = $("#floor-filter").value;
  const category = $("#category-filter").value;
  const status = $("#status-filter").value;
  const filtered = locations.filter((location) => {
    const haystack = [
      location.id, location.building, location.floor, location.area,
      location.position, location.category, ...(Array.isArray(location.ports) ? location.ports : []),
    ].join(" ").toLocaleLowerCase("id");
    return (!query || haystack.includes(query))
      && (!building || location.building === building)
      && (!floor || location.floor === floor)
      && (!category || location.category === category)
      && (!status || currentStatus(location) === status);
  });
  $("#location-grid").innerHTML = filtered.map(cardMarkup).join("");
  $("#location-grid").hidden = filtered.length === 0;
  $("#empty-state").hidden = filtered.length !== 0;
  const hasFilters = Boolean(query || building || floor || category || status);
  $("#clear-filters").hidden = !hasFilters;
  $("#results-count").textContent = `${filtered.length} titik ditemukan${hasFilters ? " dari " + locations.length : ""}`;
}

function setSearch(value, shouldScroll = true) {
  $("#hero-search-input").value = value;
  $("#directory-search-input").value = value;
  renderLocations();
  if (shouldScroll) $("#jelajahi").scrollIntoView({ behavior: "smooth" });
}

function showToast(message, isError = false) {
  const region = $("#toast-region");
  region.replaceChildren();
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " toast-error" : ""}`;
  toast.textContent = message;
  region.append(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 4200);
}

function addActivity(message) {
  if (!adminUser) return;
  supabaseClient.from("activity").insert({ message })
    .then(({ error }) => {
      if (error) throw error;
    })
    .catch((error) => {
      console.error("Tidak dapat mencatat aktivitas admin.", error);
      showToast("Perubahan tersimpan, tetapi riwayat aktivitas gagal dicatat.", true);
    });
}

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("dialog-open");
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
  if (!$$("dialog[open]").length) document.body.classList.remove("dialog-open");
}

function renderDetail(id) {
  const location = locations.find((item) => item.id === id);
  if (!location) {
    showToast("Titik ini tidak lagi tersedia.", true);
    return;
  }
  const ports = Array.isArray(location.ports) && location.ports.length ? location.ports.join(", ") : "Belum didata";
  $("#detail-dialog-content").innerHTML = `
    <button class="dialog-close" type="button" data-action="close-dialog" aria-label="Tutup">×</button>
    <div class="dialog-kicker">${escapeHTML(location.id)} · DETAIL TITIK</div>
    <h2 class="dialog-title" id="detail-dialog-title">${escapeHTML(location.area)}</h2>
    <p class="dialog-intro">${escapeHTML(location.building)} · ${escapeHTML(location.floor)}</p>
    <div class="detail-art">${mapIllustration(location, true)}    ${statusPill(currentStatus(location), "detail-status")}</div>
    <div class="detail-address"><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M14 7.5c0 3.6-5 8-5 8S4 11.1 4 7.5a5 5 0 1 1 10 0Z"/><circle cx="9" cy="7.5" r="1.5"/></svg>${escapeHTML(location.position)}</div>
    <div class="detail-facts">
      <div class="detail-fact"><span>Gedung & lantai</span><strong>${escapeHTML(location.building)} · ${escapeHTML(location.floor)}</strong></div>
      <div class="detail-fact"><span>Jumlah stopkontak</span><strong>${escapeHTML(String(location.outlets || 0))} titik</strong></div>
      <div class="detail-fact"><span>Jenis port</span><strong>${escapeHTML(ports)}</strong></div>
      <div class="detail-fact"><span>Terakhir diverifikasi</span><strong>${escapeHTML(formatDate(location.verifiedAt))}</strong></div>
    </div>
    <p class="detail-disclaimer">Status ini mencerminkan pemeriksaan terakhir, bukan kondisi colokan secara real-time. Jika ada perubahan, bantu laporkan ke admin.</p>
    <div class="dialog-actions"><button class="button button-outline" type="button" data-action="open-report" data-location-id="${escapeHTML(location.id)}">Laporkan masalah</button></div>`;
  openDialog($("#detail-dialog"));
}

function openReportDialog(locationId = "") {
  const config = window.LOKASI_SUPABASE_CONFIG;
  if (!supabaseClient || !config?.url || !config?.anonKey) {
    showToast("Backend belum siap. Laporan belum dapat dikirim.", true);
    return;
  }
  const options = locations
    .map((location) => `<option value="${escapeHTML(location.id)}"${location.id === locationId ? " selected" : ""}>${escapeHTML(`${location.id} · ${location.building} · ${location.area}`)}</option>`)
    .join("");
  $("#report-dialog-content").innerHTML = `
    <button class="dialog-close" type="button" data-action="close-dialog" aria-label="Tutup">×</button>
    <div class="dialog-kicker">IKUT JAGA DATA LOKASI</div>
    <h2 class="dialog-title" id="report-dialog-title">Ada yang berubah?</h2>
    <p class="dialog-intro">Ceritakan kondisi titik colokan. Admin akan memeriksa laporan sebelum memperbarui data resmi.</p>
    <form id="report-form" novalidate>
      <div class="form-grid">
        <div class="field field-full"><label for="report-location">Titik colokan</label><select id="report-location" name="locationId"><option value="">Pilih titik yang ada...</option>${options}<option value="new">Titik baru / belum terdaftar</option></select></div>
        <div class="field" id="new-building-field" hidden><label for="new-building">Gedung atau area</label><input id="new-building" name="newBuilding" maxlength="80" placeholder="Contoh: Gedung VA"></div>
        <div class="field" id="new-floor-field" hidden><label for="new-floor">Lantai atau area</label><input id="new-floor" name="newFloor" maxlength="40" placeholder="Contoh: Lantai 1"></div>
        <div class="field field-full" id="new-area-field" hidden><label for="new-area">Nama area / titik</label><input id="new-area" name="newArea" maxlength="100" placeholder="Contoh: Area belajar dekat jendela"></div>
        <div class="field"><label for="report-type">Jenis laporan</label><select id="report-type" name="type" required><option value="">Pilih masalah...</option>${REPORT_TYPES.map((type) => `<option value="${escapeHTML(type)}">${escapeHTML(type)}</option>`).join("")}</select></div>
        <div class="field"><label for="reporter-name">Nama <span>(opsional)</span></label><input id="reporter-name" name="name" maxlength="60" placeholder="Nama kamu"></div>
        <div class="field field-full"><label for="report-description">Keterangan</label><textarea id="report-description" name="description" maxlength="1000" placeholder="Jelaskan masalah atau petunjuk lokasinya..." required></textarea></div>
        <div class="field field-full"><label for="report-photo">Foto pendukung <span>(opsional, maks. 4 MB)</span></label><input id="report-photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp"><small>Hanya gambar JPEG, PNG, atau WebP. Foto diperkecil sebelum diunggah.</small></div>
      </div>
      <div class="field field-full"><label>Verifikasi keamanan</label><div id="report-captcha"></div><small id="captcha-notice" role="status"></small></div>
      <p class="form-notice">Laporan dan foto hanya dapat dibaca admin. Alamat IP di-hash untuk pembatasan spam; jangan kirim informasi sensitif. Tim admin akan memeriksa laporan sebelum data diperbarui.</p>
      <p class="form-error" id="report-error" role="alert" hidden></p>
      <div class="dialog-actions"><button class="button button-outline" type="button" data-action="close-dialog">Batal</button><button class="button button-dark" id="report-submit" type="submit" disabled>Kirim laporan <span aria-hidden="true">↗</span></button></div>
    </form>`;
  openDialog($("#report-dialog"));
  const siteKey = window.LOKASI_SUPABASE_CONFIG?.turnstileSiteKey;
  const notice = $("#captcha-notice");
  if (!siteKey || !window.turnstile) {
    notice.textContent = "Pelaporan belum aktif. Pengelola perlu mengonfigurasi proteksi anti-spam.";
    return;
  }
  window.turnstile.render($("#report-captcha"), {
    sitekey: siteKey,
    callback: (token) => {
      $("#report-form input[name='cf-turnstile-response']")?.remove();
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "cf-turnstile-response";
      input.value = token;
      $("#report-form").append(input);
      $("#report-submit").disabled = false;
      notice.textContent = "";
    },
    "expired-callback": () => {
      $("#report-submit").disabled = true;
      notice.textContent = "Verifikasi kedaluwarsa. Silakan verifikasi kembali.";
    },
    "error-callback": () => {
      $("#report-submit").disabled = true;
      notice.textContent = "Verifikasi keamanan gagal dimuat. Muat ulang halaman atau coba lagi.";
    },
  });
}

function showNewLocationFields() {
  const visible = $("#report-location").value === "new";
  ["#new-building-field", "#new-floor-field", "#new-area-field"].forEach((selector) => {
    $(selector).hidden = !visible;
  });
}

function validateReport(data) {
  if (!data.type) return "Pilih jenis laporan terlebih dahulu.";
  if (!data.description.trim()) return "Isi keterangan singkat agar admin memahami laporan.";
  if (data.locationId !== "new" && !locations.some((location) => location.id === data.locationId)) return "Pilih titik colokan yang ingin dilaporkan.";
  if (data.locationId === "new" && (!data.newBuilding.trim() || !data.newFloor.trim() || !data.newArea.trim())) {
    return "Lengkapi gedung, lantai, dan nama area untuk titik baru.";
  }
  return "";
}

function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 4 * 1024 * 1024) {
      reject(new Error("Ukuran foto melebihi 4 MB."));
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      reject(new Error("Format foto harus JPEG, PNG, atau WebP."));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Foto tidak dapat dibaca. Coba pilih file lain."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("File tidak dapat dibuka sebagai gambar."));
      image.onload = () => {
        const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Browser tidak dapat memproses foto."));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.76));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function submitReport(form) {
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  const errorMessage = validateReport(data);
  const errorElement = $("#report-error");
  errorElement.hidden = Boolean(!errorMessage);
  errorElement.textContent = errorMessage;
  if (errorMessage) return;

  const file = formData.get("photo");
  let photo = "";
  if (file instanceof File && file.size > 0) {
    try {
      photo = await downscaleImage(file);
    } catch (error) {
      errorElement.hidden = false;
      errorElement.textContent = error.message;
      return;
    }
  }
  const request = new FormData(form);
  if (photo) request.set("photo", await (await fetch(photo)).blob(), "evidence.jpg");
  const config = window.LOKASI_SUPABASE_CONFIG;
  let response;
  $("#report-submit").disabled = true;
  try {
    response = await fetch(`${config.url.replace(/\/+$/, "")}/functions/v1/submit-report`, {
      method: "POST",
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
      },
      body: request,
    });
  } catch (error) {
    console.error("Tidak dapat terhubung ke layanan laporan.", error);
    errorElement.hidden = false;
    errorElement.textContent = "Laporan tidak terkirim karena koneksi gagal. Coba lagi.";
    if (window.turnstile) window.turnstile.reset();
    return;
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || typeof result.id !== "string") {
    errorElement.hidden = false;
    errorElement.textContent = result.error || "Laporan belum dapat dikirim. Coba lagi beberapa saat.";
    if (window.turnstile) window.turnstile.reset();
    $("#report-submit").disabled = true;
    return;
  }
  renderReportSuccess(result.id);
}

function renderReportSuccess(reportId) {
  $("#report-dialog-content").innerHTML = `
    <button class="dialog-close" type="button" data-action="close-dialog" aria-label="Tutup">×</button>
    <div class="report-success"><span class="success-mark">✓</span><h3>Laporan terkirim!</h3><p>Terima kasih sudah ikut menjaga informasi fasilitas. Laporanmu telah masuk ke antrean pemeriksaan admin.</p><span class="report-code">${escapeHTML(reportId)}</span><br><button class="button button-dark" type="button" data-action="close-dialog">Selesai</button></div>`;
}

function openAdminDialog() {
  if (!supabaseClient) {
    showToast("Backend belum dikonfigurasi. Admin belum dapat masuk.", true);
    return;
  }
  $("#admin-login-content").innerHTML = `
    <button class="dialog-close" type="button" data-action="close-dialog" aria-label="Tutup">×</button>
    <div class="dialog-kicker">AREA PENGELOLAAN</div>
    <h2 class="dialog-title" id="admin-login-title">Login admin.</h2>
    <p class="dialog-intro">Gunakan akun admin yang telah didaftarkan oleh pengelola sistem.</p>
    <form id="admin-login-form" novalidate>
      <div class="form-grid">
        <div class="field field-full"><label for="admin-email">Email</label><input id="admin-email" name="email" type="email" autocomplete="username" maxlength="254" required></div>
        <div class="field field-full"><label for="admin-password">Kata sandi</label><input id="admin-password" name="password" type="password" autocomplete="current-password" required></div>
      </div>
      <p class="form-error" id="admin-login-error" role="alert" hidden></p>
      <div class="dialog-actions"><button class="button button-outline" type="button" data-action="close-dialog">Kembali</button><button class="button button-dark" type="submit">Masuk ↗</button></div>
    </form>`;
  openDialog($("#admin-login-dialog"));
}

async function signInAdmin(form) {
  const data = new FormData(form);
  const errorElement = $("#admin-login-error");
  const { data: sessionData, error } = await supabaseClient.auth.signInWithPassword({
    email: String(data.get("email") || "").trim(),
    password: String(data.get("password") || ""),
  });
  if (error) {
    errorElement.textContent = "Login gagal. Periksa email dan kata sandi admin.";
    errorElement.hidden = false;
    return;
  }
  const { data: isAdmin, error: roleError } = await supabaseClient.rpc("is_admin");
  if (roleError || !isAdmin) {
    await supabaseClient.auth.signOut();
    errorElement.textContent = roleError ? "Peran admin tidak dapat diverifikasi." : "Akun ini belum diberi akses admin.";
    errorElement.hidden = false;
    return;
  }
  adminUser = sessionData.user;
  try {
    await loadRemoteData();
    subscribeToChanges();
    closeDialog($("#admin-login-dialog"));
    enterAdmin();
  } catch (loadError) {
    console.error("Tidak dapat memuat dashboard admin.", loadError);
    errorElement.textContent = "Login berhasil, tetapi data admin gagal dimuat. Coba lagi.";
    errorElement.hidden = false;
  }
}

function enterAdmin() {
  if (!adminUser) return;
  closeDialog($("#admin-login-dialog"));
  $("#hero-search-form").closest(".hero").hidden = true;
  $(".quick-stats").hidden = true;
  $("#jelajahi").hidden = true;
  $("#cara-kerja").hidden = true;
  $(".bottom-cta").hidden = true;
  $("#admin-view").hidden = false;
  $("#admin-view").scrollIntoView({ behavior: "smooth", block: "start" });
  renderAdmin();
}

function exitAdmin() {
  $("#admin-view").hidden = true;
  $("#hero-search-form").closest(".hero").hidden = false;
  $(".quick-stats").hidden = false;
  $("#jelajahi").hidden = false;
  $("#cara-kerja").hidden = false;
  $(".bottom-cta").hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function logoutAdmin() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    console.error("Tidak dapat mengakhiri sesi admin.", error);
    showToast("Sesi admin belum dapat diakhiri. Coba lagi.", true);
    return;
  }
  adminUser = null;
  reports = [];
  activity = [];
  subscribeToChanges();
  exitAdmin();
  showToast("Berhasil keluar dari akun admin.");
}

function reportStatusClass(status) {
  if (status === REPORT_STATUS.approved) return "status-working";
  if (status === REPORT_STATUS.rejected) return "status-broken";
  return "status-review";
}

function renderAdminStats() {
  const buildings = unique(locations.map((location) => location.building)).length;
  const working = locations.filter((location) => location.status === STATUS.working).length;
  const broken = locations.filter((location) => location.status === STATUS.broken).length;
  const pending = reports.filter((report) => report.status === REPORT_STATUS.pending).length;
  return `<div class="admin-stats">
    <div class="admin-stat-card"><span>Gedung & area</span><strong>${buildings}</strong></div>
    <div class="admin-stat-card"><span>Total titik</span><strong>${locations.length}</strong></div>
    <div class="admin-stat-card"><span>Berfungsi</span><strong>${working}</strong><em> titik</em></div>
    <div class="admin-stat-card"><span>Tidak berfungsi</span><strong>${broken}</strong><em> titik</em></div>
    <div class="admin-stat-card"><span>Menunggu verifikasi</span><strong>${pending}</strong>${pending ? "<em> baru</em>" : ""}</div>
  </div>`;
}

function filteredReports() {
  const query = adminSearch.toLocaleLowerCase("id");
  return reports.filter((report) => {
    const statusMatches = activeReportFilter === "all" || report.status === activeReportFilter;
    const location = locations.find((item) => item.id === report.locationId);
    const locationLabel = report.newLocation
      ? `${report.newLocation.building} ${report.newLocation.floor} ${report.newLocation.area}`
      : location ? `${location.id} ${location.building} ${location.area}` : report.locationId;
    const text = `${report.id} ${report.type} ${report.name} ${report.description} ${locationLabel}`.toLocaleLowerCase("id");
    return statusMatches && (!query || text.includes(query));
  });
}

function renderReportsTable() {
  const rows = filteredReports();
  const body = rows.length ? rows.map((report) => {
    const location = locations.find((item) => item.id === report.locationId);
    const locationLabel = report.newLocation
      ? `${report.newLocation.building} · ${report.newLocation.floor}`
      : location ? `${location.building} · ${location.area}` : "Titik dihapus";
    const status = `<span class="status-pill ${reportStatusClass(report.status)} admin-mini-status">${escapeHTML(report.status)}</span>`;
    const actions = report.status === REPORT_STATUS.pending
      ? `<div class="table-actions"><button class="table-action" type="button" data-action="approve-report" data-id="${escapeHTML(report.id)}">Setujui</button><button class="table-action table-action-danger" type="button" data-action="reject-report" data-id="${escapeHTML(report.id)}">Tolak</button></div>`
      : report.status === REPORT_STATUS.rejected && report.rejectionReason
        ? `<span class="table-secondary">Alasan: ${escapeHTML(report.rejectionReason)}</span>`
        : "—";
    const photo = report.photoPath
      ? `<button class="table-action" type="button" data-action="view-report-photo" data-id="${escapeHTML(report.id)}">Lihat foto</button>`
      : "—";
    return `<tr>
      <td><span class="table-primary">${escapeHTML(report.id)}</span><span class="table-secondary">${escapeHTML(report.name || "Tanpa nama")}</span></td>
      <td><span class="table-primary">${escapeHTML(report.type)}</span><span class="table-secondary">${escapeHTML(locationLabel)}</span></td>
      <td><div class="report-detail">${escapeHTML(report.description)}</div></td>
      <td>${photo}</td>
      <td>${status}<span class="table-secondary">${escapeHTML(formatDate(report.createdAt?.slice(0, 10)))}</span></td>
      <td>${actions}</td>
    </tr>`;
  }).join("") : `<tr><td class="table-empty" colspan="6">${reports.length ? "Tidak ada laporan yang cocok dengan filter." : "Belum ada laporan masuk."}</td></tr>`;
  return `<div class="admin-table-wrap"><table class="admin-table"><thead><tr><th>Laporan</th><th>Titik / jenis</th><th>Keterangan</th><th>Foto</th><th>Status</th><th>Tindakan</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderLocationsTable() {
  const query = adminSearch.toLocaleLowerCase("id");
  const rows = locations.filter((location) => `${location.id} ${location.building} ${location.floor} ${location.area} ${location.position}`.toLocaleLowerCase("id").includes(query));
  const body = rows.length ? rows.map((location) => `<tr>
    <td><span class="table-primary">${escapeHTML(location.building)} · ${escapeHTML(location.floor)}</span><span class="table-secondary">${escapeHTML(location.id)}</span></td>
    <td><span class="table-primary">${escapeHTML(location.area)}</span><span class="table-secondary">${escapeHTML(location.position)}</span></td>
    <td>${escapeHTML(location.outlets || 0)} titik · ${escapeHTML(location.category || "Area publik")}</td>
    <td><select class="admin-location-status" aria-label="Ubah status ${escapeHTML(location.id)}" data-action="change-location-status" data-id="${escapeHTML(location.id)}">${Object.values(STATUS).map((status) => `<option value="${escapeHTML(status)}"${status === location.status ? " selected" : ""}>${escapeHTML(status)}</option>`).join("")}</select></td>
    <td><span class="table-secondary">Diverifikasi ${escapeHTML(formatDate(location.verifiedAt, { day: "numeric", month: "short" }))}</span></td>
    <td><div class="table-actions"><button class="table-action" type="button" data-action="edit-location" data-id="${escapeHTML(location.id)}">Edit</button><button class="table-action table-action-danger" type="button" data-action="delete-location" data-id="${escapeHTML(location.id)}" aria-label="Hapus ${escapeHTML(location.id)}">Hapus</button></div></td>
  </tr>`).join("") : `<tr><td class="table-empty" colspan="6">Tidak ada lokasi yang cocok dengan pencarian.</td></tr>`;
  return `<div class="admin-table-wrap admin-location-table"><table class="admin-table"><thead><tr><th>Lokasi</th><th>Area / posisi</th><th>Titik & kategori</th><th>Status</th><th>Diperbarui</th><th>Tindakan</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function formatActivityTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Waktu tidak diketahui";
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function renderActivityList() {
  if (!activity.length) return `<div class="activity-list"><div class="table-empty">Belum ada riwayat perubahan. Aktivitas akan tercatat di sini.</div></div>`;
  return `<div class="activity-list">${activity.map((item) => `<div class="activity-item"><span class="activity-icon" aria-hidden="true">↻</span><p>${escapeHTML(item.message)}</p><time>${escapeHTML(formatActivityTime(item.timestamp))}</time></div>`).join("")}</div>`;
}

function renderAdmin() {
  if (!adminUser) return;
  const admin = $("#admin-view");
  const pending = reports.filter((report) => report.status === REPORT_STATUS.pending).length;
  const searchLabel = activeAdminTab === "reports" ? "Cari laporan..." : "Cari titik lokasi...";
  let content = "";
  if (activeAdminTab === "reports") {
    const filters = [
      ["all", "Semua", reports.length],
      [REPORT_STATUS.pending, "Menunggu", pending],
      [REPORT_STATUS.approved, "Disetujui", reports.filter((report) => report.status === REPORT_STATUS.approved).length],
      [REPORT_STATUS.rejected, "Ditolak", reports.filter((report) => report.status === REPORT_STATUS.rejected).length],
    ];
    content = `<div class="admin-tabs">${filters.map(([value, label, count]) => `<button class="admin-tab${activeReportFilter === value ? " is-active" : ""}" type="button" data-action="report-filter" data-filter="${escapeHTML(value)}">${escapeHTML(label)}<span class="admin-tab-count">${count}</span></button>`).join("")}</div>
      <div class="admin-tools"><p>${pending} laporan perlu ditinjau sebelum data diperbarui.</p><label class="admin-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg><span class="sr-only">Cari laporan</span><input type="search" data-action="admin-search" placeholder="${searchLabel}" value="${escapeHTML(adminSearch)}"></label></div>
      ${renderReportsTable()}`;
  } else if (activeAdminTab === "locations") {
    content = `<div class="admin-tools"><p>${locations.length} titik lokasi ditampilkan di direktori.</p><button class="button button-dark" type="button" data-action="add-location">+ Tambah titik</button></div>
      <div class="admin-tools"><p>Status dapat diubah setelah pemeriksaan.</p><label class="admin-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"></circle><path d="m16 16 4.2 4.2"></path></svg><span class="sr-only">Cari titik lokasi</span><input type="search" data-action="admin-search" placeholder="${searchLabel}" value="${escapeHTML(adminSearch)}"></label></div>
      ${renderLocationsTable()}`;
  } else {
    content = `<div class="admin-tools"><p>Riwayat perubahan tersimpan di database bersama.</p></div>${renderActivityList()}`;
  }
  admin.innerHTML = `<div class="admin-shell">
    <div class="admin-top"><div><div class="eyebrow"><span class="section-number">AREA PENGELOLAAN</span> · VOKASI UI</div><h1>Dashboard admin.</h1><p>Kelola titik colokan dan verifikasi laporan komunitas.</p></div><div class="admin-top-actions"><button class="button button-outline" type="button" data-action="exit-admin">← Kembali</button><button class="button button-outline" type="button" data-action="logout-admin">Keluar</button><button class="button button-dark" type="button" data-action="add-location">+ Tambah titik</button></div></div>
    <div class="demo-banner"><strong>Data tersinkron.</strong> Perubahan disimpan di database bersama dan dibatasi berdasarkan akun admin.</div>
    ${renderAdminStats()}
    <div class="admin-tabs"><button class="admin-tab${activeAdminTab === "reports" ? " is-active" : ""}" type="button" data-action="admin-tab" data-tab="reports">Laporan<span class="admin-tab-count">${pending}</span></button><button class="admin-tab${activeAdminTab === "locations" ? " is-active" : ""}" type="button" data-action="admin-tab" data-tab="locations">Kelola lokasi</button><button class="admin-tab${activeAdminTab === "activity" ? " is-active" : ""}" type="button" data-action="admin-tab" data-tab="activity">Riwayat</button></div>
    ${content}
  </div>`;
}

async function updateLocationStatus(id, status) {
  if (!Object.hasOwn(STATUS_CLASS, status)) {
    showToast("Status yang dipilih tidak dikenal.", true);
    return;
  }
  const location = locations.find((item) => item.id === id);
  if (!location) return;
  const { error } = await supabaseClient.from("locations").update({
    status,
    verified_at: new Date().toISOString().slice(0, 10),
  }).eq("id", id);
  if (error) {
    console.error("Tidak dapat memperbarui status lokasi.", error);
    showToast("Status lokasi gagal diperbarui.", true);
    await loadRemoteData();
    return;
  }
  addActivity(`Status ${location.id} diubah menjadi ${status}.`);
  await loadRemoteData();
  showToast(`Status ${location.id} diperbarui.`);
}

async function approveReport(id) {
  const { error } = await supabaseClient.rpc("approve_report", { report_id: id });
  if (error) {
    console.error("Tidak dapat menyetujui laporan.", error);
    showToast("Laporan gagal disetujui. Periksa apakah masih menunggu verifikasi.", true);
    await loadRemoteData();
    return;
  }
  await loadRemoteData();
  showToast(`Laporan ${id} disetujui.`);
}

function openRejectDialog(id) {
  const report = reports.find((item) => item.id === id);
  if (!report || report.status !== REPORT_STATUS.pending) return;
  $("#report-dialog-content").innerHTML = `
    <button class="dialog-close" type="button" data-action="close-dialog" aria-label="Tutup">×</button>
    <div class="dialog-kicker">${escapeHTML(report.id)} · TINJAU LAPORAN</div>
    <h2 class="dialog-title" id="report-dialog-title">Tolak laporan ini?</h2>
    <p class="dialog-intro">Berikan alasan agar pelapor memahami keputusan admin.</p>
    <form id="rejection-form" data-id="${escapeHTML(report.id)}" novalidate>
      <div class="field"><label for="rejection-reason">Alasan penolakan</label><textarea id="rejection-reason" name="reason" maxlength="250" placeholder="Jelaskan mengapa laporan belum dapat diterima..." required></textarea></div>
      <p class="form-error" id="rejection-error" role="alert" hidden></p>
      <div class="dialog-actions"><button class="button button-outline" type="button" data-action="close-dialog">Batal</button><button class="button button-dark" type="submit">Tolak laporan</button></div>
    </form>`;
  openDialog($("#report-dialog"));
}

async function rejectReport(id, reason) {
  const { error } = await supabaseClient.rpc("reject_report", { report_id: id, reason });
  if (error) {
    console.error("Tidak dapat menolak laporan.", error);
    showToast("Laporan gagal ditolak. Periksa apakah masih menunggu verifikasi.", true);
    await loadRemoteData();
    return;
  }
  closeDialog($("#report-dialog"));
  await loadRemoteData();
  showToast(`Laporan ${id} ditolak.`);
}

async function submitRejection(form) {
  const reason = String(new FormData(form).get("reason") || "").trim();
  const error = $("#rejection-error");
  if (!reason) {
    error.textContent = "Alasan penolakan wajib diisi.";
    error.hidden = false;
    return;
  }
  await rejectReport(form.dataset.id, reason);
}

function openLocationForm(locationId = "") {
  const location = locations.find((item) => item.id === locationId);
  const isEditing = Boolean(location);
  const value = (key, fallback = "") => escapeHTML(location?.[key] ?? fallback);
  const ports = Array.isArray(location?.ports) ? location.ports.join(", ") : String(location?.ports || "Stopkontak listrik");
  $("#report-dialog-content").innerHTML = `
    <button class="dialog-close" type="button" data-action="close-dialog" aria-label="Tutup">×</button>
    <div class="dialog-kicker">${isEditing ? "KELOLA DATA" : "TAMBAH DATA BARU"}</div>
    <h2 class="dialog-title" id="report-dialog-title">${isEditing ? "Edit titik colokan." : "Tambah titik baru."}</h2>
    <p class="dialog-intro">Lengkapi informasi lokasi. Perubahan disimpan bersama dan terlihat oleh semua pengguna.</p>
    <form id="location-form" data-id="${escapeHTML(location?.id || "")}" novalidate>
      <div class="form-grid">
        <div class="field"><label for="location-id">ID titik</label><input id="location-id" name="id" maxlength="20" value="${value("id")}" ${isEditing ? "readonly" : ""} placeholder="Contoh: VA-05" required></div>
        <div class="field"><label for="location-building">Gedung / area</label><input id="location-building" name="building" maxlength="80" value="${value("building")}" placeholder="Gedung VA" required></div>
        <div class="field"><label for="location-floor">Lantai</label><input id="location-floor" name="floor" maxlength="40" value="${value("floor")}" placeholder="Lantai 1" required></div>
        <div class="field"><label for="location-category">Kategori area</label><input id="location-category" name="category" maxlength="50" value="${value("category", "Area belajar")}" placeholder="Area belajar"></div>
        <div class="field field-full"><label for="location-area">Nama area</label><input id="location-area" name="area" maxlength="100" value="${value("area")}" placeholder="Contoh: Ruang belajar mahasiswa" required></div>
        <div class="field field-full"><label for="location-position">Petunjuk posisi</label><input id="location-position" name="position" maxlength="150" value="${value("position")}" placeholder="Contoh: Dekat bangku panjang sebelah timur" required></div>
        <div class="field"><label for="location-outlets">Jumlah stopkontak</label><input id="location-outlets" name="outlets" type="number" min="1" max="99" value="${value("outlets", "1")}" required></div>
        <div class="field"><label for="location-ports">Jenis port</label><input id="location-ports" name="ports" maxlength="100" value="${escapeHTML(ports)}" placeholder="Stopkontak listrik, USB-A"></div>
        <div class="field field-full"><label for="location-photo">Foto lokasi <span>(opsional, maks. 4 MB)</span></label><input id="location-photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp"><small>Foto baru akan mengganti foto sebelumnya. Ilustrasi awal direktori hanya placeholder, bukan foto survei.</small>${location?.photo ? `<img class="location-photo-preview" src="${escapeHTML(location.photo)}" alt="Foto lokasi ${escapeHTML(location.area)} saat ini">` : ""}</div>
        <div class="field"><label for="location-status">Status</label><select id="location-status" name="status">${Object.values(STATUS).map((status) => `<option value="${escapeHTML(status)}"${status === (location?.status || STATUS.working) ? " selected" : ""}>${escapeHTML(status)}</option>`).join("")}</select></div>
        <div class="field"><label for="location-verified">Terakhir diverifikasi</label><input id="location-verified" name="verifiedAt" type="date" value="${value("verifiedAt", new Date().toISOString().slice(0, 10))}" required></div>
      </div>
      <p class="location-form-help">Pastikan foto tidak menampilkan informasi pribadi atau wajah orang lain tanpa izin.</p>
      <p class="form-error" id="location-error" role="alert" hidden></p>
      <div class="dialog-actions"><button class="button button-outline" type="button" data-action="close-dialog">Batal</button><button class="button button-dark" type="submit">${isEditing ? "Simpan perubahan" : "Tambah titik"} ↗</button></div>
    </form>`;
  openDialog($("#report-dialog"));
}

async function submitLocation(form) {
  const formData = new FormData(form);
  const data = Object.fromEntries(formData.entries());
  const id = data.id.trim();
  const area = data.area.trim();
  const error = $("#location-error");
  const originalId = form.dataset.id;
  const editing = Boolean(originalId);
  if (!id || !data.building.trim() || !data.floor.trim() || !area || !data.position.trim() || !data.verifiedAt) {
    error.textContent = "Lengkapi semua informasi wajib sebelum menyimpan.";
    error.hidden = false;
    return;
  }
  if (!/^[a-zA-Z0-9-]+$/.test(id)) {
    error.textContent = "ID hanya boleh berisi huruf, angka, dan tanda hubung.";
    error.hidden = false;
    return;
  }
  if (!/^\d+$/.test(data.outlets) || Number(data.outlets) < 1 || Number(data.outlets) > 99) {
    error.textContent = "Jumlah stopkontak harus berupa angka antara 1 dan 99.";
    error.hidden = false;
    return;
  }
  if (locations.some((item) => item.id === id && item.id !== originalId)) {
    error.textContent = "ID tersebut sudah dipakai. Gunakan ID yang berbeda.";
    error.hidden = false;
    return;
  }
  const existing = locations.find((item) => item.id === originalId);
  let photoPath = existing?.photoPath || null;
  let uploadedPath = "";
  const imageFile = formData.get("photo");
  if (imageFile instanceof File && imageFile.size > 0) {
    try {
      const photo = await downscaleImage(imageFile);
      const blob = await (await fetch(photo)).blob();
      uploadedPath = `locations/${id}-${crypto.randomUUID()}.jpg`;
      const { error: uploadError } = await supabaseClient.storage.from("location-photos").upload(uploadedPath, blob, {
        contentType: "image/jpeg",
        upsert: false,
      });
      if (uploadError) throw uploadError;
      photoPath = uploadedPath;
    } catch (imageError) {
      error.textContent = imageError.message;
      error.hidden = false;
      return;
    }
  }
  const next = {
    id,
    building: data.building.trim(),
    floor: data.floor.trim(),
    area,
    position: data.position.trim(),
    category: data.category.trim() || "Area publik",
    outlets: Number(data.outlets),
    ports: data.ports.split(",").map((port) => port.trim()).filter(Boolean),
    status: data.status,
    verified_at: data.verifiedAt,
    art: editing ? locations.find((item) => item.id === originalId)?.art || 1 : ((locations.length % 6) + 1),
    photo_path: photoPath,
  };
  const result = editing
    ? await supabaseClient.from("locations").update(next).eq("id", originalId)
    : await supabaseClient.from("locations").insert(next);
  if (result.error) {
    if (uploadedPath) {
      const { error: cleanupError } = await supabaseClient.storage.from("location-photos").remove([uploadedPath]);
      if (cleanupError) console.error("Tidak dapat membersihkan foto lokasi yang tidak tersimpan.", cleanupError);
    }
    console.error("Tidak dapat menyimpan lokasi ke backend.", result.error);
    error.textContent = "Lokasi gagal disimpan. Periksa koneksi dan izin akun admin.";
    error.hidden = false;
    return;
  }
  if (uploadedPath && existing?.photoPath) {
    const { error: removeError } = await supabaseClient.storage.from("location-photos").remove([existing.photoPath]);
    if (removeError) console.error("Foto lama tidak dapat dihapus dari penyimpanan.", removeError);
  }
  closeDialog($("#report-dialog"));
  addActivity(editing ? `Informasi titik ${id} diperbarui.` : `Titik baru ${id} ditambahkan ke direktori.`);
  activeAdminTab = "locations";
  if (!editing) adminSearch = "";
  await loadRemoteData();
  showToast(editing ? `Titik ${id} berhasil diperbarui.` : `Titik ${id} berhasil ditambahkan.`);
}

async function deleteLocation(id) {
  const location = locations.find((item) => item.id === id);
  if (!location) return;
  if (!window.confirm(`Hapus titik ${id} (${location.area}) dari direktori bersama? Laporan lama akan tetap tersimpan.`)) return;
  const { error } = await supabaseClient.from("locations").delete().eq("id", id);
  if (error) {
    console.error("Tidak dapat menghapus lokasi.", error);
    showToast("Lokasi gagal dihapus. Periksa izin akun admin.", true);
    return;
  }
  if (location.photoPath) {
    const { error: photoError } = await supabaseClient.storage.from("location-photos").remove([location.photoPath]);
    if (photoError) console.error("Foto lokasi tidak dapat dihapus.", photoError);
  }
  addActivity(`Titik ${id} dihapus dari direktori.`);
  await loadRemoteData();
  showToast(`Titik ${id} dihapus.`);
}

async function viewReportPhoto(id) {
  const report = reports.find((item) => item.id === id);
  if (!report?.photoPath) {
    showToast("Foto laporan tidak tersedia.", true);
    return;
  }
  const { data, error } = await supabaseClient.storage.from("report-evidence").createSignedUrl(report.photoPath, 300);
  if (error) {
    console.error("Tidak dapat membuka foto laporan.", error);
    showToast("Foto laporan tidak dapat dibuka.", true);
    return;
  }
  $("#detail-dialog-content").innerHTML = `
    <button class="dialog-close" type="button" data-action="close-dialog" aria-label="Tutup">×</button>
    <div class="dialog-kicker">${escapeHTML(report.id)} · FOTO LAPORAN</div>
    <h2 class="dialog-title" id="detail-dialog-title">${escapeHTML(report.type)}</h2>
    <p class="dialog-intro">${escapeHTML(report.description)}</p>
    <img class="report-photo-view" src="${escapeHTML(data.signedUrl)}" alt="Foto bukti laporan ${escapeHTML(report.id)}">
    <div class="dialog-actions"><button class="button button-outline" type="button" data-action="close-dialog">Tutup</button></div>`;
  openDialog($("#detail-dialog"));
}

function refreshViews() {
  renderStats();
  renderFilterOptions();
  renderLocations();
  if (!$("#admin-view").hidden) renderAdmin();
}

function clearFilters() {
  $("#hero-search-input").value = "";
  $("#directory-search-input").value = "";
  $("#building-filter").value = "";
  $("#floor-filter").value = "";
  $("#category-filter").value = "";
  $("#status-filter").value = "";
  renderLocations();
}

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
  if (!target) return;
  const action = target.dataset.action;

  if (action === "open-admin") openAdminDialog();
  if (action === "open-report") {
    const locationId = target.dataset.locationId || "";
    if ($("#detail-dialog").open) closeDialog($("#detail-dialog"));
    openReportDialog(locationId);
  }
  if (action === "open-detail") renderDetail(target.dataset.id);
  if (action === "close-dialog") {
    const dialog = target.closest("dialog");
    if (dialog) closeDialog(dialog);
  }
  if (action === "exit-admin") exitAdmin();
  if (action === "logout-admin") logoutAdmin().catch((error) => {
    console.error("Tidak dapat mengakhiri sesi admin.", error);
    showToast("Sesi admin belum dapat diakhiri. Coba lagi.", true);
  });
  if (action === "toggle-menu") {
    const nav = $(".desktop-nav");
    const expanded = target.getAttribute("aria-expanded") === "true";
    target.setAttribute("aria-expanded", String(!expanded));
    nav.classList.toggle("menu-open", !expanded);
  }
  if (action === "report-filter") {
    activeReportFilter = target.dataset.filter;
    renderAdmin();
  }
  if (action === "admin-tab") {
    activeAdminTab = target.dataset.tab;
    adminSearch = "";
    renderAdmin();
  }
  if (action === "approve-report") approveReport(target.dataset.id).catch((error) => {
    console.error("Tidak dapat menyetujui laporan.", error);
    showToast("Laporan gagal disetujui.", true);
  });
  if (action === "reject-report") openRejectDialog(target.dataset.id);
  if (action === "edit-location") openLocationForm(target.dataset.id);
  if (action === "add-location") openLocationForm();
  if (action === "delete-location") deleteLocation(target.dataset.id).catch((error) => {
    console.error("Tidak dapat menghapus lokasi.", error);
    showToast("Lokasi gagal dihapus.", true);
  });
  if (action === "view-report-photo") viewReportPhoto(target.dataset.id).catch((error) => {
    console.error("Tidak dapat membuka foto laporan.", error);
    showToast("Foto laporan tidak dapat dibuka.", true);
  });
  if (action === "report-filter" || action === "admin-tab") $("#admin-view").scrollIntoView({ behavior: "smooth", block: "start" });
  if (target.matches("[data-search]")) {
    setSearch(target.dataset.search);
  }
  if (action === "clear-filters") clearFilters();
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.matches("#hero-search-input")) {
    $("#directory-search-input").value = target.value;
    renderLocations();
  }
  if (target.matches("#directory-search-input")) renderLocations();
  if (target.matches('input[data-action="admin-search"]')) {
    const start = target.selectionStart;
    const end = target.selectionEnd;
    adminSearch = target.value;
    renderAdmin();
    const next = $('input[data-action="admin-search"]');
    next?.focus();
    if (next && start !== null && end !== null) next.setSelectionRange(start, end);
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.matches("#building-filter, #floor-filter, #category-filter, #status-filter")) renderLocations();
  if (target.matches("#report-location")) showNewLocationFields();
  if (target.matches('select[data-action="change-location-status"]')) {
    updateLocationStatus(target.dataset.id, target.value).catch((error) => {
      console.error("Tidak dapat mengubah status lokasi.", error);
      showToast("Status lokasi gagal diperbarui.", true);
    });
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id === "hero-search-form") {
    event.preventDefault();
    setSearch($("#hero-search-input").value);
  }
  if (event.target.id === "report-form") {
    event.preventDefault();
    submitReport(event.target).catch((error) => {
      console.error("Tidak dapat mengirim laporan.", error);
      const errorElement = $("#report-error");
      errorElement.textContent = "Terjadi kesalahan saat mengirim laporan. Coba lagi.";
      errorElement.hidden = false;
    });
  }
  if (event.target.matches("form#admin-login-form")) {
    event.preventDefault();
    signInAdmin(event.target).catch((error) => {
      console.error("Login admin gagal.", error);
      const errorElement = $("#admin-login-error");
      errorElement.textContent = "Login admin belum dapat diproses. Coba lagi.";
      errorElement.hidden = false;
    });
  }
  if (event.target.matches("form#location-form")) {
    event.preventDefault();
    submitLocation(event.target).catch((error) => {
      console.error("Tidak dapat menyimpan lokasi.", error);
      const errorElement = $("#location-error");
      errorElement.textContent = "Terjadi kesalahan saat menyimpan. Periksa data dan coba lagi.";
      errorElement.hidden = false;
    });
  }
  if (event.target.matches("form#rejection-form")) {
    event.preventDefault();
    submitRejection(event.target).catch((error) => {
      console.error("Tidak dapat menolak laporan.", error);
      showToast("Laporan gagal ditolak.", true);
    });
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase("id") === "k") {
    event.preventDefault();
    $("#directory-search-input").focus();
    $("#jelajahi").scrollIntoView({ behavior: "smooth" });
  }
  if (event.key === "Escape") {
    const menuButton = $(".mobile-menu-button");
    menuButton.setAttribute("aria-expanded", "false");
    $(".desktop-nav").classList.remove("menu-open");
  }
});

$$("dialog").forEach((dialog) => {
  dialog.addEventListener("close", () => {
    if (!$$("dialog[open]").length) document.body.classList.remove("dialog-open");
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
});

$("#current-year").textContent = String(new Date().getFullYear());
renderFilterOptions();
renderStats();
renderLocations();
initializeBackend();
