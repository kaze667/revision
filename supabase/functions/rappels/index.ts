// Fonction Supabase Edge "rappels" : envoie les notifications push du matin et du soir.
// Appelée toutes les 10 minutes par pg_cron (en-tête x-cron-secret), ou par l'appli
// pour un test (en-tête Authorization de l'utilisateur connecté + {"test": true}).
// Secrets à définir : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, CRON_SECRET.
// Aucune IA ici : les résumés sont calculés à partir des données, donc gratuits.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:revisions@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------- Dates dans le fuseau de l'utilisateur ----------
function localNow(tz: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(new Date());
  } catch {
    return localNow("Indian/Reunion");
  }
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hm: `${g("hour")}:${g("minute")}`, weekday: g("weekday") };
}
const toMin = (hm: string) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
const parseD = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const diffDays = (a: string, b: string) => Math.round((parseD(a) - parseD(b)) / 86400000);

type Row = { coll: string; id: string; data: Record<string, any> };

async function userDocs(uid: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("docs").select("coll,id,data").eq("user_id", uid)
      .in("coll", ["chapitres", "examens", "cartes", "stats", "plan"]).order("coll").order("id").range(from, from + 999);
    if (error) throw error;
    rows.push(...(data as Row[]));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

function plural(n: number, one: string, many: string) { return n + " " + (n > 1 ? many : one); }


// Temps de révision du jour (plan/reglages) : exception datée > semaine type > temps général (90 min par défaut). 0 = jour off.
function budgetFor(rows: Row[], date: string): number {
  // L'aperçu écrit par l'appli tient compte de l'emploi du temps (jours chargés) : on le préfère quand il couvre ce jour.
  const ap: any = rows.find((x) => x.coll === "plan" && x.id === "apercu")?.data ?? {};
  if (ap.temps && ap.temps[date] !== undefined && ap.majLe && diffDays(date, ap.majLe) <= 6) { const v = Number(ap.temps[date]); if (isFinite(v)) return v <= 0 ? 0 : Math.max(15, Math.min(600, v)); }
  const r: any = rows.find((x) => x.coll === "plan" && x.id === "reglages")?.data ?? {};
  const ex = r.exceptions ?? {}, sem = Array.isArray(r.semaine) ? r.semaine : [];
  const [y, m, d] = date.split("-").map(Number), wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const v = ex[date] !== undefined && ex[date] !== null ? ex[date] : sem[wd] !== undefined && sem[wd] !== null && sem[wd] !== "" ? sem[wd] : r.minutesJour;
  let n = Number(v);
  if (!isFinite(n)) n = 90;
  if (n > 0) { let x = 0; for (const k of Object.values(r.renforts || {}) as any[]) if (k && date >= (k.depuis || "") && date <= k.jusqu) x += Number(k.extra) || 0; if (x) n = Math.min(n + x, Math.max(n, 240)); }
  return n <= 0 ? 0 : Math.max(15, Math.min(600, n));
}
// Rythme réel des flashcards sur 14 jours (secondes par carte mesurées, part de cartes ratées), comme sur l'appli.
function cardPace(rows: Row[], date: string) {
  const st = rows.filter((r) => r.coll === "stats" && r.id <= date && diffDays(date, r.id) < 14).map((r) => r.data ?? {});
  const n = st.reduce((a, s) => a + (s.chrono ?? 0), 0), sec = st.reduce((a, s) => a + (s.secondes ?? 0), 0);
  const w = Math.min(1, n / 20), secCard = Math.max(12, Math.min(150, w * (n ? sec / n : 45) + (1 - w) * 45));
  const rev = st.reduce((a, s) => a + (s.revues ?? 0), 0), ok = st.reduce((a, s) => a + (s.justes ?? 0), 0);
  const fail = rev >= 20 ? Math.max(0.05, Math.min(0.5, 1 - ok / rev)) : 0.2;
  return { secCard, fail };
}
const fmtMin = (m: number) => { m = Math.max(1, Math.round(m)); return m < 60 ? m + " min" : Math.floor(m / 60) + " h" + (m % 60 ? " " + String(m % 60).padStart(2, "0") : ""); };

// ---------- Contenu du rappel, calculé sans IA ----------
function buildMessage(rows: Row[], date: string, moment: "matin" | "soir", prenom: string | null, dimanche = false) {
  const chap = rows.filter((r) => r.coll === "chapitres");
  const exams = rows.filter((r) => r.coll === "examens").map((r) => r.data).filter((e) => e.date >= date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const cards = rows.filter((r) => r.coll === "cartes").map((r) => r.data).filter((c) => !c.suspendue);
  const stats = rows.find((r) => r.coll === "stats" && r.id === date)?.data ?? {};

  const calDue: string[] = [], j0Today: string[] = [];
  for (const c of chap) {
    for (const s of c.data.etapes ?? []) {
      if (s.fait || !s.due || s.due > date) continue;
      if (s.code === "J0") j0Today.push(c.data.titre);
      else calDue.push(c.data.titre);
    }
  }
  const soonExam = exams.some((e) => diffDays(e.date, date) <= 10);
  const B = budgetFor(rows, date), pace = cardPace(rows, date);
  const durable = B ? Math.max(3, Math.floor(B * 0.5 * 60 / pace.secCard / 6)) : 0;
  const newLeft = Math.max(0, Math.min(20 + (soonExam ? 10 : 0), durable) - (stats.nouvelles ?? 0));
  const dueAll = cards.filter((c) => !c.nouveau && (c.due ?? date) <= date).length;
  const perRev = (1 + pace.fail) * pace.secCard / 60, perNew = 1.5 * (1 + Math.min(0.6, pace.fail + 0.15)) * pace.secCard / 60;
  const dueCards = B ? Math.min(dueAll, Math.max(1, Math.floor(B * 0.7 / perRev))) : 0;
  const newCards = Math.min(newLeft, cards.filter((c) => c.nouveau).length, Math.max(0, Math.floor((B * 0.7 - dueCards * perRev) / perNew)));
  const nCards = dueCards + newCards;
  const minutes = dueCards * perRev + newCards * perNew;
  const next = exams[0];
  const dNext = next ? diffDays(next.date, date) : null;
  const examName = next ? `${next.matiere} (${next.intitule})` : "";
  const examTxt = next && dNext !== null && dNext <= 7 ? (dNext === 0 ? `Examen de ${examName} aujourd'hui, courage !` : dNext === 1 ? `Examen de ${examName} demain.` : `Examen de ${examName} dans ${dNext} jours.`) : "";
  const name = prenom ? " " + prenom : "";

  if (!B && !(next && dNext !== null && dNext <= 1)) {
    if (moment === "soir") return null;
    return { title: `Bonjour${name}`, body: "Jour off aujourd'hui : repose-toi, tes révisions sont réparties sur les jours suivants." + (examTxt ? " " + examTxt : ""), tag: "matin", url: "./#jour" };
  }
  if (moment === "matin") {
    const parts: string[] = [];
    if (calDue.length) parts.push(plural(calDue.length, "révision au calendrier", "révisions au calendrier"));
    if (nCards) parts.push(`${nCards} flashcards (≈ ${fmtMin(minutes)})`);
    const body = (parts.length ? "Aujourd'hui : " + parts.join(" et ") + "." : "Rien d'urgent aujourd'hui : un petit exercice pour garder le rythme ?") + (B ? " Ton temps : " + fmtMin(B) + "." : "") + (examTxt ? " " + examTxt : "");
    return { title: `Bonjour${name}`, body, tag: "matin", url: "./#jour" };
  }
  const parts: string[] = [];
  if (j0Today.length) parts.push("Rappel libre ce soir : " + j0Today.slice(0, 3).join(", ") + (j0Today.length > 3 ? "…" : "") + ".");
  const reviewedToday = (stats.revues ?? 0) > 0;
  if (dueCards && !reviewedToday) parts.push(`${dueCards} flashcards t'attendent encore (≈ ${fmtMin(dueCards * perRev)}).`);
  if (next && dNext === 1) parts.push(`Examen de ${examName} demain : flashcards du programme et un exercice type examen ce soir, puis dors bien.`);
  if (dimanche) parts.push("Fin de semaine : fais ton bilan dans l'onglet Aujourd'hui pour préparer la suivante.");
  if (!parts.length) parts.push("Tu as eu cours aujourd'hui ? Ajoute-le pour programmer ses révisions.");
  return { title: `Bonsoir${name}`, body: parts.join(" "), tag: "soir", url: "./#jour" };
}

async function sendTo(uid: string, payload: Record<string, unknown>) {
  const { data: subs } = await admin.from("push_subs").select("endpoint,subscription").eq("user_id", uid);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(s.subscription, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "normal" });
      sent++;
    } catch (e: any) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint);
      else console.error("push error", code, e?.body ?? e?.message);
    }
  }
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));

  // Test depuis l'appli : on identifie l'utilisateur grâce à son jeton de connexion.
  if (body?.test) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) return json({ error: "non connecté" }, 401);
    const { data: p } = await admin.from("profiles").select("prenom").eq("user_id", data.user.id).maybeSingle();
    const sent = await sendTo(data.user.id, { title: "Test réussi" + (p?.prenom ? ", " + p.prenom : ""), body: "Tes rappels du matin et du soir arriveront ici.", tag: "test", url: "./#reglages" });
    return json({ sent });
  }

  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return json({ error: "interdit" }, 401);

  const { data: profiles, error } = await admin.from("profiles").select("user_id,prenom,tz,heure_matin,heure_soir,last_matin,last_soir").eq("notif_on", true);
  if (error) return json({ error: error.message }, 500);

  let envoyes = 0;
  for (const p of profiles ?? []) {
    const { date, hm, weekday } = localNow(p.tz || "Indian/Reunion");
    for (const moment of ["matin", "soir"] as const) {
      const target = moment === "matin" ? p.heure_matin : p.heure_soir;
      const last = moment === "matin" ? p.last_matin : p.last_soir;
      const late = toMin(hm) - toMin(target);
      // Envoi dans les 3 heures qui suivent l'heure choisie, une seule fois par jour.
      if (late < 0 || late > 180 || last === date) continue;
      try {
        const msg = buildMessage(await userDocs(p.user_id), date, moment, p.prenom, weekday === "Sun");
        if (msg) envoyes += await sendTo(p.user_id, msg);
        await admin.from("profiles").update(moment === "matin" ? { last_matin: date } : { last_soir: date }).eq("user_id", p.user_id);
      } catch (e) {
        console.error("rappel", p.user_id, e);
      }
    }
  }
  return json({ ok: true, envoyes });
});
