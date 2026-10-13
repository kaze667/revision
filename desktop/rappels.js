// Contenu des rappels du matin et du soir, calculé sans IA à partir des données locales.
// Même logique que la fonction "rappels" de la version web (supabase/functions/rappels).
"use strict";

const pad = n => String(n).padStart(2, "0");
function localNow(d = new Date()) {
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`, dimanche: d.getDay() === 0 };
}
const toMin = hm => { const [h, m] = String(hm || "00:00").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const parseD = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const diffDays = (a, b) => Math.round((parseD(a) - parseD(b)) / 86400000);
const plural = (n, one, many) => n + " " + (n > 1 ? many : one);

// rows : [{ coll, id, data }]
function buildMessage(rows, date, moment, prenom, dimanche = false) {
  const chap = rows.filter(r => r.coll === "chapitres");
  const exams = rows.filter(r => r.coll === "examens").map(r => r.data).filter(e => e && e.date >= date).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const cards = rows.filter(r => r.coll === "cartes").map(r => r.data).filter(c => c && !c.suspendue);
  const statsRow = rows.find(r => r.coll === "stats" && r.id === date);
  const stats = (statsRow && statsRow.data) || {};

  const calDue = [], j0Today = [];
  for (const c of chap) {
    for (const s of (c.data && c.data.etapes) || []) {
      if (s.fait || !s.due || s.due > date) continue;
      if (s.code === "J0") j0Today.push(c.data.titre); else calDue.push(c.data.titre);
    }
  }
  const soonExam = exams.some(e => diffDays(e.date, date) <= 10);
  const newLeft = Math.max(0, 20 + (soonExam ? 10 : 0) - (stats.nouvelles || 0));
  const dueCards = cards.filter(c => !c.nouveau && (c.due || date) <= date).length;
  const newCards = Math.min(newLeft, cards.filter(c => c.nouveau).length);
  const nCards = dueCards + newCards;
  const minutes = Math.max(1, Math.round(nCards * 0.4));
  const next = exams[0];
  const dNext = next ? diffDays(next.date, date) : null;
  const examName = next ? `${next.matiere} (${next.intitule})` : "";
  const examTxt = next && dNext !== null && dNext <= 7 ? (dNext === 0 ? `Examen de ${examName} aujourd'hui, courage !` : dNext === 1 ? `Examen de ${examName} demain.` : `Examen de ${examName} dans ${dNext} jours.`) : "";
  const name = prenom ? " " + prenom : "";

  if (moment === "matin") {
    const parts = [];
    if (calDue.length) parts.push(plural(calDue.length, "révision au calendrier", "révisions au calendrier"));
    if (nCards) parts.push(`${nCards} flashcards (≈ ${minutes} min)`);
    const body = (parts.length ? "Aujourd'hui : " + parts.join(" et ") + "." : "Rien d'urgent aujourd'hui : un petit exercice pour garder le rythme ?") + (examTxt ? " " + examTxt : "");
    return { title: `Bonjour${name}`, body, tag: "matin" };
  }
  const parts = [];
  if (j0Today.length) parts.push("Rappel libre ce soir : " + j0Today.slice(0, 3).join(", ") + (j0Today.length > 3 ? "…" : "") + ".");
  if (dueCards && !((stats.revues || 0) > 0)) parts.push(`${dueCards} flashcards t'attendent encore (≈ ${Math.max(1, Math.round(dueCards * 0.4))} min).`);
  if (next && dNext === 1) parts.push(`Examen de ${examName} demain : flashcards du programme et un exercice type examen ce soir, puis dors bien.`);
  if (dimanche) parts.push("Fin de semaine : fais ton bilan dans l'onglet Aujourd'hui pour préparer la suivante.");
  if (!parts.length) parts.push("Tu as eu cours aujourd'hui ? Ajoute-le pour programmer ses révisions.");
  return { title: `Bonsoir${name}`, body: parts.join(" "), tag: "soir" };
}

// Quels rappels envoyer maintenant ? Fenêtre de 3 h après l'heure choisie, une fois par jour
// (si le PC était éteint à l'heure pile, le rappel part dès qu'il se rallume dans ces 3 h).
function dueMoments(settings, now = new Date()) {
  if (!settings || settings.notif_on === false) return [];
  const { date, hm } = localNow(now);
  const out = [];
  for (const moment of ["matin", "soir"]) {
    const target = moment === "matin" ? settings.heure_matin || "07:00" : settings.heure_soir || "20:00";
    const last = moment === "matin" ? settings.last_matin : settings.last_soir;
    const late = toMin(hm) - toMin(target);
    if (late >= 0 && late <= 180 && last !== date) out.push(moment);
  }
  return out;
}

module.exports = { localNow, buildMessage, dueMoments, diffDays };
