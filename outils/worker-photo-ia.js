// Petit serveur (Cloudflare Worker) pour « Voir avec ma photo (IA) ».
// Version 5 du 22/11/2026 (directive d'Antoine 2026-11-22-catalogue-ra-zone-et-verification) : le client TOUCHE l'endroit
// de sa photo où il veut le produit. La page envoie alors, en plus de la v4, un masque (« mask » : PNG de la même taille
// que la photo, transparent là où l'IA peut peindre, opaque ailleurs), la pose (« pose » : sol, mur, table, plafond) et la
// zone visée pour le produit (« zone » : x0,y0,x1,y1 en fractions de la photo). L'IA ne retouche que la zone du masque.
// Doc OpenAI lue le 22/11/2026 (developers.openai.com, images/edits et guide image-generation) : champ « mask », PNG avec
// canal alpha, même format et même taille que l'image à modifier ; avec plusieurs images, le masque s'applique à la
// PREMIÈRE (la photo du client, envoyée en premier ici) ; le masque guide le modèle, sans frontière stricte (la page ne
// recolle donc que la zone).
// Compatible v4 : sans « mask », comportement v4 (l'IA place le produit seule) ; sans « ref », comportement v3.
// Les champs texte sont nettoyés et bornés ici : la consigne est écrite par le serveur, jamais par la page.
// Aucun décodage d'image ici (limite de calcul gratuite de Cloudflare) ; rien n'est gardé ici.
// À coller tel quel par Antoine dans Cloudflare (Workers, « Edit code »). Secret : CLE_IA (clé du projet OpenAI
// « catalogue-ra »). Variables : ORIGINE = https://antoinebarthelemy.dev ; MODELE = gpt-image-2.6-sunburst.

const CONSIGNE_V3 = [
  "This is a real photo of a room. A 3D piece of furniture has been composited into it.",
  "Make the composite look like a natural, real photograph: match the room's lighting direction, light colour,",
  "contact shadows on the floor and reflections on the furniture.",
  "Do NOT change the furniture's shape, proportions, position, size, materials, texture pattern or colours.",
  "Do NOT change anything else in the photo: walls, floor, objects and framing stay exactly the same, no stretching, no cropping.",
].join(" ");

const propre = (v, max) => String(v ?? "").replace(/[^\p{L}\p{N} ,.'()\/-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
const cote = (v) => { const n = Math.round(Number(v)); return n > 0 && n < 2000 ? n : null; };
const POSES = {
  sol: "standing on the floor, its base resting on the floor at the bottom of the area",
  mur: "hanging flat against the wall, centred in the area",
  table: "standing on the table, shelf or furniture top at the bottom of the area",
  plafond: "hanging from the ceiling at the top of the area",
};
// Zone visée : 4 nombres entre 0 et 1, dans l'ordre, sinon rien.
function zone(v) {
  const z = String(v ?? "").split(",").map(Number);
  if (z.length !== 4 || z.some((n) => !Number.isFinite(n) || n < 0 || n > 1) || z[2] <= z[0] || z[3] <= z[1]) return null;
  return z.map((n) => Math.round(n * 100));
}

function entete(e, nbRefs) {
  const nom = propre(e.get("nom"), 90) || "the product";
  const cat = propre(e.get("categorie"), 40);
  return `Image 1 is a real photo of a customer's home. Image${nbRefs > 1 ? "s 2 to " + (nbRefs + 1) : " 2"} show${nbRefs > 1 ? "" : "s"} one product sold by a shop: "${nom}"${cat ? " (" + cat + ")" : ""}, seen on a plain background.`;
}
function dims(e) {
  const l = cote(e.get("l")), p = cote(e.get("p")), h = cote(e.get("h"));
  return l && p && h ? `Its real size is ${l} cm wide, ${p} cm deep and ${h} cm high: render it at exactly this real-world scale relative to the room.` : "Render it at a realistic real-world scale.";
}
const FIDELE = "The product must be identical to the reference images: same shape, proportions, materials, texture pattern and colours. Do not redesign, simplify or restyle it, and do not replace it with another object.";

function consigneDirecte(e, nbRefs) {
  return [
    entete(e, nbRefs),
    "Edit image 1 to show this exact product placed in the room, where such a product would naturally go (on the floor, against a wall, on a table or shelf, or hanging, depending on the product), in free space, without hiding or replacing an existing piece of furniture.",
    dims(e), FIDELE,
    "Match the room's perspective, lighting direction and colour, with natural contact shadows and reflections, so the result looks like a real, unedited photograph.",
    "Keep everything else in image 1 exactly as it is: same framing, same walls, floor, objects and colours; no cropping, no stretching, no added objects other than the product.",
  ].join(" ");
}

function consigneZone(e, nbRefs) {
  const pose = POSES[String(e.get("pose"))] || "placed naturally";
  const z = zone(e.get("zone"));
  const ou = z ? `The customer chose where it goes: the product should fill roughly the box from ${z[0]}% to ${z[2]}% of the image width and from ${z[1]}% to ${z[3]}% of the image height (measured from the top left), ${pose}.` : `The customer chose where it goes: inside the editable area of the mask, ${pose}.`;
  return [
    entete(e, nbRefs),
    "Edit ONLY the transparent area of the mask in image 1: add this exact product there, with its natural contact shadow.",
    ou, dims(e), FIDELE,
    "Show the whole product, not cut off. Match the room's perspective, lighting direction and colour, with natural shadows and reflections, so the result looks like a real, unedited photograph.",
    "Outside the product and its shadow, keep image 1 exactly as it is: same framing, walls, floor, objects and colours; do not move, remove or replace anything; no cropping, no stretching, no other added object.",
  ].join(" ");
}

export default {
  async fetch(req, env) {
    // X-Serveur : la page sait que le masque est pris en compte (sinon elle ne paie pas d'essais supplémentaires).
    const cors = { "Access-Control-Allow-Origin": env.ORIGINE, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Expose-Headers": "X-Serveur", "X-Serveur": "5" };
    const erreur = (m) => new Response(JSON.stringify({ error: { message: m } }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST" || req.headers.get("Origin") !== env.ORIGINE) return new Response("interdit", { status: 403 });
    const entree = await req.formData();
    const image = entree.get("image");
    if (!image || typeof image === "string" || image.size > 12_000_000) return erreur("image absente ou trop lourde");
    const refs = entree.getAll("ref").filter((r) => r && typeof r !== "string" && r.size <= 6_000_000).slice(0, 2);
    const m = entree.get("mask");
    const masque = refs.length && m && typeof m !== "string" && m.size <= 6_000_000 && /png/i.test(m.type || "image/png") ? m : null;
    const taille = /^(\d{3,4})x(\d{3,4})$/.test(String(entree.get("taille"))) ? String(entree.get("taille")) : "auto";
    const appel = (fidelite) => {
      const f = new FormData();
      f.append("model", env.MODELE || "gpt-image-2.6-sunburst");
      if (refs.length) {
        f.append("prompt", masque ? consigneZone(entree, refs.length) : consigneDirecte(entree, refs.length));
        f.append("image[]", image, "piece.png");
        refs.forEach((r, i) => f.append("image[]", r, "produit-" + (i + 1) + ".png"));
        if (masque) f.append("mask", masque, "masque.png");
      } else {
        f.append("prompt", CONSIGNE_V3);
        f.append("image", image, "piece.png");
      }
      f.append("size", taille);
      f.append("quality", "medium");
      f.append("output_format", "jpeg");
      if (fidelite) f.append("input_fidelity", "high");
      return fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer " + env.CLE_IA }, body: f });
    };
    let r = await appel(true);
    // Si le réglage de fidélité élevée est refusé par le modèle, on réessaie une fois sans lui.
    if (r.status === 400) { const t = await r.clone().text(); if (/input_fidelity/i.test(t)) r = await appel(false); }
    // Réponse d'OpenAI renvoyée telle quelle (image en base64 dans data[0].b64_json, ou message d'erreur).
    return new Response(r.body, { status: r.status, headers: { ...cors, "Content-Type": "application/json" } });
  },
};
