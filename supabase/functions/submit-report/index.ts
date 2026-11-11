import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const reportTypes = new Set([
  "Colokan rusak",
  "Colokan tidak berfungsi",
  "Stopkontak longgar",
  "Port USB tidak berfungsi",
  "Titik colokan sudah tidak tersedia",
  "Informasi lokasi tidak sesuai",
  "Menambahkan titik colokan baru",
]);

function response(status: number, body: Record<string, string>, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin, Vary: "Origin" },
  });
}

Deno.serve(async (request: Request) => {
  const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN") || "";
  const origin = request.headers.get("origin") || "";
  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: { ...corsHeaders, "Access-Control-Allow-Origin": origin, Vary: "Origin" },
    });
  }
  if (!allowedOrigin || origin !== allowedOrigin) {
    return response(403, { error: "Origin tidak diizinkan." }, allowedOrigin || origin);
  }
  if (request.method !== "POST") return response(405, { error: "Metode tidak diizinkan." }, allowedOrigin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const turnstileSecret = Deno.env.get("TURNSTILE_SECRET");
  const rateLimitSalt = Deno.env.get("RATE_LIMIT_SALT");
  if (!supabaseUrl || !serviceKey || !turnstileSecret || !rateLimitSalt) {
    console.error("Required submit-report function secrets are missing.");
    return response(503, { error: "Layanan laporan belum dikonfigurasi." }, allowedOrigin);
  }

  try {
    const form = await request.formData();
    const captchaToken = form.get("cf-turnstile-response");
    if (typeof captchaToken !== "string" || !captchaToken) {
      return response(400, { error: "Selesaikan verifikasi keamanan terlebih dahulu." }, allowedOrigin);
    }

    const ip = request.headers.get("cf-connecting-ip")
      || request.headers.get("x-forwarded-for")?.split(",")[0].trim()
      || "unknown";
    const captchaBody = new URLSearchParams({ secret: turnstileSecret, response: captchaToken, remoteip: ip });
    const captchaResponse = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: captchaBody,
    });
    if (!captchaResponse.ok) throw new Error("Turnstile verification request failed.");
    const captcha = await captchaResponse.json();
    const expectedHostname = Deno.env.get("TURNSTILE_EXPECTED_HOSTNAME");
    if (!captcha.success || (expectedHostname && captcha.hostname !== expectedHostname)) {
      return response(400, { error: "Verifikasi keamanan gagal. Coba lagi." }, allowedOrigin);
    }

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${rateLimitSalt}:${ip}`));
    const ipHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: withinLimit, error: limitError } = await supabase.rpc("consume_report_submission_limit", {
      p_ip_hash: ipHash,
    });
    if (limitError) throw limitError;
    if (!withinLimit) return response(429, { error: "Batas laporan sementara tercapai. Coba lagi satu jam lagi." }, allowedOrigin);

    const locationId = form.get("locationId");
    const type = form.get("type");
    const name = form.get("name");
    const description = form.get("description");
    if (typeof locationId !== "string" || typeof type !== "string" || !reportTypes.has(type)
      || typeof name !== "string" || name.length > 60
      || typeof description !== "string" || !description.trim() || description.length > 1000) {
      return response(400, { error: "Data laporan tidak lengkap atau tidak valid." }, allowedOrigin);
    }

    let newLocation = null;
    if (locationId === "new") {
      const building = form.get("newBuilding");
      const floor = form.get("newFloor");
      const area = form.get("newArea");
      if (typeof building !== "string" || !building.trim() || building.length > 80
        || typeof floor !== "string" || !floor.trim() || floor.length > 40
        || typeof area !== "string" || !area.trim() || area.length > 100) {
        return response(400, { error: "Informasi titik baru tidak lengkap atau tidak valid." }, allowedOrigin);
      }
      newLocation = { building: building.trim(), floor: floor.trim(), area: area.trim() };
    } else {
      const { data: location, error: locationError } = await supabase
        .from("locations").select("id").eq("id", locationId).maybeSingle();
      if (locationError) throw locationError;
      if (!location) return response(400, { error: "Titik lokasi yang dipilih tidak ditemukan." }, allowedOrigin);
    }

    const photo = form.get("photo");
    if (photo !== null && !(photo instanceof File)) {
      return response(400, { error: "Foto laporan tidak valid." }, allowedOrigin);
    }
    if (photo instanceof File && photo.size > 0 && (photo.size > 4 * 1024 * 1024 || photo.type !== "image/jpeg")) {
      return response(400, { error: "Foto harus berupa JPEG dengan ukuran maksimal 4 MB." }, allowedOrigin);
    }

    const id = `LAP-${new Date().toISOString().slice(2, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const photoPath = photo instanceof File && photo.size > 0 ? `reports/${id}.jpg` : null;
    if (photoPath && photo instanceof File) {
      const { error: uploadError } = await supabase.storage.from("report-evidence").upload(
        photoPath,
        new Uint8Array(await photo.arrayBuffer()),
        { contentType: "image/jpeg", upsert: false },
      );
      if (uploadError) throw uploadError;
    }

    const { error: insertError } = await supabase.from("reports").insert({
      id,
      location_id: locationId,
      new_location: newLocation,
      type,
      name: name.trim(),
      description: description.trim(),
      photo_path: photoPath,
    });
    if (insertError) {
      if (photoPath) {
        const { error: cleanupError } = await supabase.storage.from("report-evidence").remove([photoPath]);
        if (cleanupError) console.error("Could not remove an orphaned report photo.", cleanupError);
      }
      throw insertError;
    }
    return response(201, { id }, allowedOrigin);
  } catch (error) {
    console.error("submit-report failed.", error);
    return response(500, { error: "Laporan belum dapat dikirim. Coba lagi beberapa saat." }, allowedOrigin);
  }
});
