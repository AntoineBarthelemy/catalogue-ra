// « Voir avec ma photo » (nouveau système, directive d'Antoine du 23/11/2026) :
// 1) la photo est analysée sur le téléphone (profondeur Depth Anything V2 Small, Apache-2.0, par Transformers.js) :
//    rien ne quitte le téléphone, aucun coût par photo ;
// 2) le sol est retrouvé dans la carte de profondeur (un plan), ce qui donne l'inclinaison du téléphone et l'échelle
//    (appareil supposé à 1,35 m du sol) ; la surface touchée (sol, mur, table, plafond) est reconnue par sa pente ;
// 3) le client touche un endroit : notre vrai modèle 3D (three.js) y apparaît, à sa taille réelle, posé au sol ou accroché
//    au mur, avec une ombre et une lumière tirées de la photo ; il le glisse et le tourne du doigt ;
// 4) aucune IA générative : rien n'est inventé, le produit est fidèle à 100 %.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const HAUTEUR_APPAREIL = 1.35;   // m, téléphone tenu debout
const FOCALE = 0.75;             // focale en part du côté long (grand angle d'un téléphone, environ 26 mm)
const MODELE_PROFONDEUR = "onnx-community/depth-anything-v2-small";
const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1";
const COTE_ANALYSE = 640, COTE_EXPORT = 1600;
const borne = (v, a, b) => Math.min(b, Math.max(a, v));
// Focale de l'appareil : lue dans la photo (EXIF, équivalent 35 mm) quand le téléphone l'y écrit, sinon 26 mm supposés.
export function focale35(buf) {
  const v = new DataView(buf); if (v.getUint16(0) !== 0xFFD8) return null;
  let o = 2;
  while (o + 4 < v.byteLength) {
    const m = v.getUint16(o), l = v.getUint16(o + 2);
    if (m === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) {
      const t = o + 10, le = v.getUint16(t) === 0x4949, u16 = (p) => v.getUint16(t + p, le), u32 = (p) => v.getUint32(t + p, le);
      const lire = (ifd, tag) => { const n = u16(ifd); for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (u16(e) === tag) return e; } return null; };
      const ifd0 = u32(4), ex = lire(ifd0, 0x8769); if (ex === null) return null;
      const e = lire(u32(ex + 8), 0xA405); return e === null ? null : u16(e + 8) || null;
    }
    if ((m & 0xFF00) !== 0xFF00) return null; o += 2 + l;
  }
  return null;
}

// ---------- 1. Profondeur ----------
let estimateur = null;
async function profondeur(canvas, progres) {
  if (!estimateur) {
    const { pipeline, env } = await import(TRANSFORMERS);
    env.allowLocalModels = false;
    estimateur = await pipeline("depth-estimation", MODELE_PROFONDEUR, {
      device: "wasm", dtype: "q8",
      progress_callback: (e) => { if (e.status === "progress" && e.total) progres?.(e.loaded / e.total); },
    });
  }
  const url = canvas.toDataURL("image/jpeg", 0.92);
  const r = await estimateur(url);
  const t = r.predicted_depth, dims = t.dims.slice(-2);
  return { h: dims[0], w: dims[1], d: Float32Array.from(t.data) };
}

// ---------- 2. Géométrie : plans dans la carte de disparité ----------
// Pour un plan n.X = -c vu par une caméra à l'origine, la disparité 1/Z est linéaire en (u, v) = coordonnées normalisées :
// 1/Z = -(n.(u, v, 1)) / c. La carte du modèle vaut a / Z (décalage supposé nul) : un plan y est aussi linéaire.
function grille(dep, W, H, f) {
  const G = 96, gh = Math.round(G * H / W), pts = [];
  for (let j = 0; j < gh; j++) for (let i = 0; i < G; i++) {
    const x = (i + 0.5) / G, y = (j + 0.5) / gh;
    const d = dep.d[Math.min(dep.h - 1, Math.floor(y * dep.h)) * dep.w + Math.min(dep.w - 1, Math.floor(x * dep.w))];
    pts.push({ x, y, u: (x * W - W / 2) / f, v: (y * H - H / 2) / f, d });
  }
  return pts;
}
function resoudre3(A, b) { // Cramer
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A); if (Math.abs(D) < 1e-12) return null;
  return [0, 1, 2].map((k) => det(A.map((l, i) => l.map((v, j) => (j === k ? b[i] : v)))) / D);
}
function moindresCarres(pts) { // d = p0 + p1 u + p2 v
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const p of pts) { const r = [1, p.u, p.v]; for (let i = 0; i < 3; i++) { b[i] += r[i] * p.d; for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; } }
  return resoudre3(A, b);
}
// Tirage reproductible : la même photo donne toujours la même taille.
let graineAlea = 1;
function alea() { graineAlea = (graineAlea + 0x6D2B79F5) | 0; let t = Math.imul(graineAlea ^ (graineAlea >>> 15), 1 | graineAlea); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function ransac(pts, tol, iters = 260) {
  graineAlea = 12345;
  if (pts.length < 12) return null;
  let meilleur = null, nb = 0;
  for (let k = 0; k < iters; k++) {
    const s = [0, 1, 2].map(() => pts[Math.floor(alea() * pts.length)]);
    const q = moindresCarres(s); if (!q) continue;
    let n = 0; for (const p of pts) if (Math.abs(q[0] + q[1] * p.u + q[2] * p.v - p.d) < tol) n++;
    if (n > nb) { nb = n; meilleur = q; }
  }
  if (!meilleur) return null;
  const inl = pts.filter((p) => Math.abs(meilleur[0] + meilleur[1] * p.u + meilleur[2] * p.v - p.d) < tol);
  return { q: moindresCarres(inl) || meilleur, part: inl.length / pts.length };
}
// Normale (repère image : x droite, y bas, z devant), tournée vers l'appareil, et k = a / c.
const normale = (q, b = 0) => { const v = [-q[1], -q[2], -(q[0] - b)], k = Math.hypot(...v); return { n: v.map((x) => x / k), k }; };
const ajuster = (pts, q, tol) => pts.filter((p) => Math.abs(q[0] + q[1] * p.u + q[2] * p.v - p.d) < tol);

// La carte du modèle vaut d = a / Z + b (échelle a et décalage b inconnus). Le sol donne un plan (p) ; un mur, un autre (q).
// Murs verticaux : leur normale est perpendiculaire à celle du sol, ce qui donne b (équation du second degré) ;
// puis l'appareil à 1,35 m du sol donne a. Sans mur net : inclinaison du téléphone supposée de 10 degrés.
function analyserPiece(dep, W, H, focale = FOCALE) {
  const f = focale * Math.max(W, H), pts = grille(dep, W, H, f);
  let min = Infinity, max = -Infinity; for (const p of pts) { if (p.d < min) min = p.d; if (p.d > max) max = p.d; }
  const tol = (max - min) * 0.012, info = { min, max };
  // Sol : graine dans le bas de la photo (15 %), puis étendu à toute la moitié basse.
  let sol = null, graine = ransac(pts.filter((p) => p.y > 0.85), tol);
  if (graine && graine.q[2] > 0) {
    let q = graine.q; for (let k = 0; k < 2; k++) q = moindresCarres(ajuster(pts.filter((p) => p.y > 0.45), q, tol * 1.5)) || q;
    const inl = ajuster(pts, q, tol * 1.5); info.solPart = +(inl.length / pts.length).toFixed(3);
    if (q[2] > 0 && inl.length > pts.length * 0.06) sol = { q, inl };
  }
  let b = null;
  if (sol) {
    // Murs : plans dans le reste de la photo (hors sol), deux essais.
    let reste = pts.filter((p) => Math.abs(sol.q[0] + sol.q[1] * p.u + sol.q[2] * p.v - p.d) >= tol * 1.5 && p.y < 0.9);
    const p = sol.q, cands = [];
    for (let m = 0; m < 3 && reste.length > 40; m++) {
      const w = ransac(reste, tol, 200); if (!w || w.part < 0.15) break;
      const q = w.q, B = p[0] + q[0], C = p[0] * q[0] + p[1] * q[1] + p[2] * q[2], disc = B * B - 4 * C;
      const inlW = ajuster(reste, q, tol);
      if (disc >= 0) for (const r of [(B - Math.sqrt(disc)) / 2, (B + Math.sqrt(disc)) / 2]) {
        const minPlans = Math.min(...sol.inl.map((x) => x.d), ...inlW.map((x) => x.d));
        const up = normale(p, r).n;
        if (r < minPlans && up[1] < -0.5) cands.push({ b: r, poids: inlW.length, up });
      }
      reste = reste.filter((x) => Math.abs(q[0] + q[1] * x.u + q[2] * x.v - x.d) >= tol);
    }
    info.murs = cands.map((c) => ({ b: +c.b.toFixed(3), poids: c.poids, incl: Math.round(Math.asin(borne(-c.up[2], -1, 1)) * 180 / Math.PI) }));
    if (cands.length) { cands.sort((x, y) => y.poids - x.poids); b = cands[0].b; info.source = "mur"; }
    else { b = p[0] - p[2] * Math.tan(10 * Math.PI / 180); info.source = "incl10"; } // roulis ignoré
    const { n, k } = normale(p, b);
    sol = { q: p, n, a: k * HAUTEUR_APPAREIL, b, inclinaison: Math.asin(borne(-n[2], -1, 1)) * 180 / Math.PI };
  }
  return { W, H, f, pts, tol, sol, b: b ?? 0, info, dep };
}
function disparite(piece, x, y) { // x, y en part de la photo, moyenne 3 x 3
  const { dep } = piece; let s = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const i = borne(Math.floor(x * dep.w) + dx, 0, dep.w - 1), j = borne(Math.floor(y * dep.h) + dy, 0, dep.h - 1);
    s += dep.d[j * dep.w + i]; n++;
  }
  return s / n;
}
// Surface touchée : plan local autour du point, comparé au sol.
function surface(piece, x, y) {
  const R = 0.07, voisins = piece.pts.filter((p) => Math.abs(p.x - x) < R && Math.abs(p.y - y) < R * piece.W / piece.H);
  const loc = ransac(voisins, piece.tol * 1.3, 150);
  const haut = piece.sol ? piece.sol.n : [0, -1, 0];
  const u = (x * piece.W - piece.W / 2) / piece.f, v = (y * piece.H - piece.H / 2) / piece.f;
  const a = piece.sol ? piece.sol.a : null, d = disparite(piece, x, y);
  // Distance : par l'échelle du sol, sinon 2 m supposés.
  const Z = a && d > piece.b ? borne(a / (d - piece.b), 0.4, 12) : 2;
  const P = [u * Z, v * Z, Z];
  if (!loc || loc.part < 0.45) return { type: "inconnu", P, n: null, haut };
  const { n } = normale(loc.q, piece.b), c = n[0] * haut[0] + n[1] * haut[1] + n[2] * haut[2];
  const hauteur = -(P[0] * haut[0] + P[1] * haut[1] + P[2] * haut[2]); // sous l'appareil (> 0) ou au-dessus (< 0)
  let type = "mur";
  if (c > 0.8) type = hauteur > HAUTEUR_APPAREIL - 0.25 ? "sol" : "table";
  else if (c < -0.8) type = "plafond";
  else if (Math.abs(c) > 0.45) type = "incline";
  return { type, P, n, haut, hauteur };
}

// ---------- 3. Lumière tirée de la photo ----------
function lumiere(img) {
  const c = document.createElement("canvas"), w = 48, h = Math.max(8, Math.round(48 * img.naturalHeight / img.naturalWidth));
  c.width = w; c.height = h; const g = c.getContext("2d"); g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, moy = (y0, y1) => { const s = [0, 0, 0]; let n = 0; for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; } return s.map((v) => v / n / 255); };
  const haut = moy(0, 0.5), bas = moy(0.5, 1), tout = moy(0, 1);
  let bx = 0.5, by = 0.2, bl = -1;
  for (let y = 0; y < Math.floor(h * 0.6); y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, l = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; if (l > bl) { bl = l; bx = (x + 0.5) / w; by = (y + 0.5) / h; } }
  const lum = tout[0] * 0.3 + tout[1] * 0.59 + tout[2] * 0.11;
  const teinte = (c) => { const m = Math.max(...c, 1e-3); return new THREE.Color(...c.map((v) => 0.55 + 0.45 * v / m)); };
  return { haut: teinte(haut), bas: teinte(bas), tout: teinte(tout), lum, bx, by };
}

// ---------- 4. Scène ----------
const versTrois = (v) => new THREE.Vector3(v[0], -v[1], -v[2]);
const chargeur = new GLTFLoader(), cacheModeles = new Map();
async function modele(url) {
  if (!cacheModeles.has(url)) cacheModeles.set(url, chargeur.loadAsync(url));
  const g = await cacheModeles.get(url); return g.scene.clone(true);
}
function texteOmbre() {
  const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d");
  const r = g.createRadialGradient(64, 64, 4, 64, 64, 64); r.addColorStop(0, "rgba(0,0,0,0.75)"); r.addColorStop(0.55, "rgba(0,0,0,0.3)"); r.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
}

export class PoseurPhoto {
  constructor(conteneur, img, f35 = null) {
    this.conteneur = conteneur; this.img = img; this.focale = f35 && f35 > 10 && f35 < 200 ? f35 / 36 : FOCALE; this.f35 = f35;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping; this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement; this.canvas.className = "pose-3d"; conteneur.appendChild(this.canvas);
    this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(this.renderer); this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45;
    this.angle = 0; this.echelle = 1; this.objet = null;
  }
  async analyser(progres) {
    const W0 = this.img.naturalWidth, H0 = this.img.naturalHeight, s = COTE_ANALYSE / Math.max(W0, H0);
    const c = document.createElement("canvas"); c.width = Math.round(W0 * s); c.height = Math.round(H0 * s);
    c.getContext("2d").drawImage(this.img, 0, 0, c.width, c.height);
    try { this.piece = analyserPiece(await profondeur(c, progres), W0, H0, this.focale); this.profondeurOk = true; }
    catch (e) { console.warn("profondeur indisponible", e); this.profondeurOk = false; this.piece = { W: W0, H: H0, f: this.focale * Math.max(W0, H0), sol: null, pts: [] }; }
    const f = this.piece.f;
    this.camera = new THREE.PerspectiveCamera(2 * Math.atan(H0 / 2 / f) * 180 / Math.PI, W0 / H0, 0.05, 60);
    this.lum = lumiere(this.img);
    try {
      const tex = new THREE.Texture(this.img); tex.needsUpdate = true; tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.SRGBColorSpace;
      const pm = new THREE.PMREMGenerator(this.renderer); this.scene.environment = pm.fromEquirectangular(tex).texture; this.scene.environmentIntensity = 0.9;
    } catch (e) { console.warn("environnement photo", e); }
    this.renderer.toneMappingExposure = borne(Math.pow(this.lum.lum / 0.45, 0.8), 0.35, 1.3); // pièce sombre : produit plus sombre
    const hemi = new THREE.HemisphereLight(this.lum.haut, this.lum.bas, 1.1); this.scene.add(hemi);
    this.soleil = new THREE.DirectionalLight(this.lum.tout, 1.9); this.soleil.castShadow = true;
    this.soleil.shadow.mapSize.set(1024, 1024); this.soleil.shadow.radius = 14; this.soleil.shadow.bias = -0.0005;
    Object.assign(this.soleil.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 0.1, far: 20 });
    this.scene.add(this.soleil, this.soleil.target);
    this.redimensionner();
    return { profondeur: this.profondeurOk, sol: !!this.piece.sol, inclinaison: this.piece.sol ? Math.round(this.piece.sol.inclinaison) : null, info: this.piece.info, focale35: this.f35 };
  }
  redimensionner() {
    const r = this.img.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    this.renderer.setPixelRatio(dpr); this.renderer.setSize(r.width, r.height, false);
    this.canvas.style.width = r.width + "px"; this.canvas.style.height = r.height + "px"; this.rendre();
  }
  piedDuMur(x, y) {
    const pc = this.piece, sl = pc.sol; if (!sl) return null;
    let suite = 0;
    for (let yy = y + 0.02; yy < 0.995; yy += 0.01) {
      const u = (x * pc.W - pc.W / 2) / pc.f, v = (yy * pc.H - pc.H / 2) / pc.f, d = disparite(pc, x, yy);
      if (Math.abs(sl.q[0] + sl.q[1] * u + sl.q[2] * v - d) < pc.tol * 1.5) { if (++suite >= 3) return yy - 0.02; } else suite = 0;
    }
    return null;
  }
  haut() { return versTrois(this.piece.sol ? this.piece.sol.n : [0, -1, 0]).normalize(); }
  rayon(x, y) { // x, y en part de la photo -> direction (repère three)
    const { W, H, f } = this.piece; return versTrois([(x * W - W / 2) / f, (y * H - H / 2) / f, 1]).normalize();
  }
  // Pose du produit à l'endroit touché. Renvoie { ok } ou { refus: message }.
  async poser(produit, pose, x, y) {
    const s = surface(this.piece, x, y), U = this.haut(), P = versTrois(s.P);
    let plan, pos, type = pose;
    const sol = () => new THREE.Plane(U.clone(), HAUTEUR_APPAREIL); // U.p + h = 0 : le sol, 1,35 m sous l'appareil
    if (pose === "sol") {
      if (s.type === "mur" || s.type === "plafond") return { refus: "Touchez le sol, là où le produit doit être posé (pas le mur)." , surface: s.type };
      plan = sol();
    } else if (pose === "table") {
      if (s.type === "mur" || s.type === "plafond") return { refus: "Touchez le dessus d'une table, d'une console ou d'une étagère (pas le mur).", surface: s.type };
      plan = s.type === "sol" || s.type === "inconnu" && !this.piece.sol ? sol() : new THREE.Plane().setFromNormalAndCoplanarPoint(U.clone(), P);
      if (s.type === "sol") type = "sol";
    } else if (pose === "mur") {
      if (s.type === "sol" || s.type === "table") return { refus: "Touchez le mur, là où le produit doit être accroché.", surface: s.type };
      let N = s.n && s.type === "mur" ? versTrois(s.n).normalize() : this.rayon(x, y).negate();
      N.sub(U.clone().multiplyScalar(N.dot(U))).normalize(); // mur vertical
      // Distance du mur : par son pied, là où le sol commence sous le point touché (même échelle que les objets posés au sol).
      let appui = P; const yb = this.piedDuMur(x, y);
      if (yb !== null) { const F = new THREE.Vector3(); if (new THREE.Ray(new THREE.Vector3(), this.rayon(x, yb)).intersectPlane(sol(), F) && F.length() < 12) appui = F; }
      this.pied = yb;
      plan = new THREE.Plane().setFromNormalAndCoplanarPoint(N, appui);
    } else { // plafond : touché au plafond, ou sur la table / le sol au-dessus duquel la suspension pend
      if (s.type === "plafond") plan = new THREE.Plane().setFromNormalAndCoplanarPoint(U.clone(), P), type = "plafond";
      else { const base = s.type === "table" ? new THREE.Plane().setFromNormalAndCoplanarPoint(U.clone(), P) : sol(); plan = base; type = "au-dessus"; }
    }
    pos = new THREE.Vector3(); if (!new THREE.Ray(new THREE.Vector3(), this.rayon(x, y)).intersectPlane(plan, pos)) pos.copy(P);
    if (pos.length() > 12) return { refus: "Cet endroit est trop loin dans la photo. Touchez un endroit plus proche.", surface: s.type };
    if (!this.objet || this.objetId !== produit.id) {
      if (this.objet) this.scene.remove(this.groupe);
      this.objet = await modele(produit.glb); this.objetId = produit.id;
      this.objet.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) if (m && m.metalness > 0.4) { m.envMapIntensity = 2.4; m.needsUpdate = true; } } }); // métal et verre : reflets de la pièce plus marqués
      const b = new THREE.Box3().setFromObject(this.objet); this.boite = b;
      this.groupe = new THREE.Group(); this.porteur = new THREE.Group(); this.porteur.add(this.objet); this.groupe.add(this.porteur);
      this.ombreSol = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22 }));
      this.ombreSol.receiveShadow = true;
      this.contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texteOmbre(), transparent: true, depthWrite: false, opacity: 0.55 }));
      this.groupe.add(this.ombreSol, this.contact); this.scene.add(this.groupe);
    }
    this.pose = { type, plan, U, x, y, surface: s.type, produit };
    this.placer(pos); this.rendre();
    return { ok: true, surface: s.type, distance: +pos.length().toFixed(2), type };
  }
  placer(pos) {
    const { type, plan, U } = this.pose, b = this.boite, size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const e = this.echelle;
    this.objet.position.set(-c.x, 0, -c.z); this.objet.scale.setScalar(1);
    let F, Up = U.clone();
    if (type === "mur") {
      F = plan.normal.clone(); Up = U.clone().sub(F.clone().multiplyScalar(U.dot(F))).normalize();
      this.objet.position.set(-c.x, -c.y, -b.min.z); // dos contre le mur, centre au point touché
    } else {
      F = pos.clone().negate(); F.sub(U.clone().multiplyScalar(F.dot(U))).normalize();
      F.applyAxisAngle(U, this.angle);
      if (type === "plafond") this.objet.position.y = -b.max.y;
      else if (type === "au-dessus") this.objet.position.y = 0.75 - b.min.y; // le bas de la suspension à 75 cm au-dessus
      else this.objet.position.y = -b.min.y;
    }
    const X = new THREE.Vector3().crossVectors(Up, F).normalize();
    this.groupe.matrixAutoUpdate = true;
    this.groupe.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Up, F));
    this.groupe.position.copy(pos); this.porteur.scale.setScalar(e);
    // Ombres : sur le support (sol, table, mur) ; pour une suspension, sur ce qui est dessous.
    const plat = type !== "mur", dessous = type === "plafond" ? -(HAUTEUR_APPAREIL + this.groupe.position.dot(U)) : 0;
    this.ombreSol.scale.set(4, 4, 1); this.contact.visible = type === "sol" || type === "table";
    if (plat) {
      this.ombreSol.rotation.set(-Math.PI / 2, 0, 0); this.ombreSol.position.set(0, (type === "plafond" ? Math.min(-0.5, dessous) : 0.002), 0);
      this.contact.rotation.set(-Math.PI / 2, 0, 0); this.contact.position.set(0, 0.003, 0);
      this.contact.scale.set(size.x * e * 1.2, size.z * e * 1.2, 1);
    } else { this.ombreSol.rotation.set(0, 0, 0); this.ombreSol.position.set(0, 0, 0.002); }
    // Soleil : presque au-dessus du produit, penché d au plus 30 degrés vers le côté le plus clair de la photo : ombre courte, attachée au pied.
    const cote = this.rayon(this.lum.bx, this.lum.by).multiplyScalar(5).sub(pos); cote.sub(U.clone().multiplyScalar(cote.dot(U)));
    if (cote.lengthSq() > 1e-6) cote.normalize().multiplyScalar(0.55);
    this.soleil.position.copy(pos.clone().add(U.clone().add(cote).normalize().multiplyScalar(6)));
    this.soleil.target.position.copy(pos); this.soleil.target.updateMatrixWorld();
  }
  deplacer(x, y) {
    if (!this.pose) return; const pos = new THREE.Vector3(), { type, plan, U } = this.pose;
    let p = plan; if (type === "au-dessus" || type === "plafond") p = plan; // même plan que la pose
    if (new THREE.Ray(new THREE.Vector3(), this.rayon(x, y)).intersectPlane(p, pos) && pos.length() < 12) { this.placer(pos); this.rendre(); }
  }
  tourner(da) { if (!this.pose || this.pose.type === "mur") return; this.angle += da; this.placer(this.groupe.position.clone()); this.rendre(); }
  taille(f) { if (!this.pose) return; this.echelle = borne(this.echelle * f, 0.5, 2); this.placer(this.groupe.position.clone()); this.rendre(); }
  rendre() { if (this.camera) this.renderer.render(this.scene, this.camera); }
  // Image finale : la photo d'origine (côté long 1600 px) + le rendu 3D à la même taille.
  async exporter() {
    const W0 = this.img.naturalWidth, H0 = this.img.naturalHeight, s = Math.min(1, COTE_EXPORT / Math.max(W0, H0));
    const w = Math.round(W0 * s), h = Math.round(H0 * s), c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); g.drawImage(this.img, 0, 0, w, h);
    const pr = this.renderer.getPixelRatio(), taille = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setPixelRatio(1); this.renderer.setSize(w, h, false); this.rendre(); g.drawImage(this.canvas, 0, 0, w, h);
    this.renderer.setPixelRatio(pr); this.renderer.setSize(taille.x, taille.y, false); this.rendre();
    const txt = "Montage 3D du produit, à titre indicatif", fs = Math.round(w / 46);
    g.font = `600 ${fs}px Inter, system-ui, sans-serif`; const tw = g.measureText(txt).width;
    g.fillStyle = "rgba(0,0,0,0.6)"; g.fillRect(fs * 0.6, h - fs * 2.3, tw + fs * 1.2, fs * 1.7); g.fillStyle = "#fff"; g.fillText(txt, fs * 1.2, h - fs * 1.05);
    return c.toDataURL("image/jpeg", 0.9);
  }
  detruire() { this.renderer.dispose(); this.canvas.remove(); }
}
