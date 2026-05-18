import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Landmark, Upload, Loader2, TrendingUp, TrendingDown, CheckCircle, FileText, AlertCircle, RefreshCw, Download, X, Sparkles, Eye } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { analyserReleveIA } from "@/server/factures.functions";

export const Route = createFileRoute("/_app/dossiers/$dossierId/banque")({
  component: BanquePage,
});

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Compte { id: string; banque: string | null; intitule: string | null; rib: string | null; solde_actuel: number; }
interface TxBancaire { id: string; date_operation: string; libelle: string | null; type: string; montant: number; solde_apres: number | null; rapproche: boolean; }
interface Releve { id: string; fichier_nom: string | null; statut: string; nombre_transactions: number; solde_initial: number; solde_final: number; created_at: string; }
interface FactureNonPayee { id: string; type: "client" | "fournisseur"; numero: string | null; nom: string; montant_ttc: number; date_echeance: string | null; }

interface TxExtracted {
  date_operation: string; date_valeur: string; reference: string;
  libelle: string; type: "credit" | "debit"; montant: number;
  categorie: string; compte_comptable: string;
  reference_facture: string | null; confiance: number;
  facture_id: string | null; alerte: string | null;
  tiers_nom: string | null; etape_rapprochement: string;
}

interface InfoReleve { banque: string; rib: string; solde_initial: number; solde_final: number; }

// ─── Server function : analyse Gemini → catégorisation + matching ─────────────


// ─── Helpers (portés exactement de bank_statement_parser_BP_ATTIJARI_PROPRE.py) ──

const AMOUNT_RE_STR = String.raw`\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2}|\d+[,.]\s*\d{2}`;
const AMOUNT_RE = new RegExp(AMOUNT_RE_STR, 'g');

const OCR_FIXES: Record<string,string> = {
  "C0MMISSI0N":"COMMISSION","C0MMISSION":"COMMISSION","COMMISSI0N":"COMMISSION",
  "S0CIETE":"SOCIETE","D0CUMENT":"DOCUMENT","C0MPTE":"COMPTE",
  "M0NETIQUE":"MONETIQUE","CHE0UE":"CHEQUE","CHE0UES":"CHEQUES",
};

function norm(s: string): string {
  if (!s) return "";
  s = String(s).replace(/[|\[\]{}!]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function cleanAmount(s: string): number | null {
  if (!s) return null;
  let v = s.replace(/\xa0/g," ").replace(/O/gi,"0").replace(/[^\d,.\s]/g,"");
  v = v.replace(/\s/g,"");
  if (!v) return null;
  if (v.endsWith(",") || v.endsWith(".")) v += "00";
  if (v.includes(",")) v = v.replace(/\./g,"").replace(",",".");
  const n = parseFloat(v);
  return isNaN(n) || n <= 0 ? null : Math.round(n * 100) / 100;
}

function cleanDateParts(d: string, m: string, y: string): string | null {
  try {
    const dd = parseInt(d.replace(/O/gi,"0"));
    const mm = parseInt(m.replace(/O/gi,"0"));
    const yy = parseInt(y.replace(/O/gi,"0"));
    if (isNaN(dd)||isNaN(mm)||isNaN(yy)) return null;
    return `${String(dd).padStart(2,"0")}/${String(mm).padStart(2,"0")}/${yy}`;
  } catch { return null; }
}

function cleanNatureText(text: string): string {
  if (!text) return "";
  let t = norm(text).toUpperCase();
  for (const [a,b] of Object.entries(OCR_FIXES)) t = t.split(a).join(b);
  t = t.replace(/(?<=[A-Z])0(?=[A-Z])/g, "O");
  return t.replace(/\s+/g," ").trim();
}

function looksCredit(nature: string): boolean {
  const u = (nature||"").toUpperCase();
  return ["RECU","REÇU","REMISE","VERSEMENT RECU","VIR.WEB RECU","VIR INST RECU"].some(k => u.includes(k));
}

// ── awb_line_to_tx — porté EXACTEMENT de bank_statement_parser_BP_ATTIJARI_PROPRE.py ──
function awbLineToTx(line: string, year: number): any | null {
  const raw = norm(line).replace(/@/g,"0");
  let pr = raw.replace(/O/g,"0").replace(/o/g,"0");
  pr = pr.replace(/(?<=[A-Z0-9])[lI](?=\d{2}\s+\d{2})/g," ").replace(/\//g," ");

  let m = pr.match(/^(?<code>[A-Z0-9]{6,7})\s*(?<d1>\d{2})\s+(?<m1>\d{2})\s+(?<rest>.+)$/i);
  if (!m) m = pr.match(/^(?<code>[A-Z0-9]{6})(?<d1>\d{2})\s+(?<m1>\d{2})\s+(?<rest>.+)$/i);
  if (!m?.groups) return null;

  const code = m.groups.code.toUpperCase();
  const d1 = m.groups.d1, m1 = m.groups.m1;
  const rest = norm(m.groups.rest);

  const dateMatches = [...rest.matchAll(/(\d{2})\s+(\d{2})\s+(20\d{2})/g)];
  if (!dateMatches.length) return null;
  const dm = dateMatches[dateMatches.length - 1];
  const d2 = dm[1], m2 = dm[2], y2 = dm[3];

  const dmIdx = dm.index!;
  let nature = cleanNatureText(rest.slice(0, dmIdx));
  const tail = norm(rest.slice(dmIdx + dm[0].length));

  let amounts = [...tail.matchAll(new RegExp(AMOUNT_RE_STR,"g"))].map(a => a[0]);
  let amount = amounts.length ? cleanAmount(amounts[0]) : null;

  if (amount === null) {
    amounts = [...rest.matchAll(new RegExp(AMOUNT_RE_STR,"g"))].map(a => a[0]);
    amount = amounts.length ? cleanAmount(amounts[0]) : null;
    if (amounts.length) nature = cleanNatureText(nature.replace(amounts[0],""));
  }
  if (amount === null) return null;

  const cr = looksCredit(nature);
  return {
    ligne: null,
    date_operation: cleanDateParts(d1, m1, String(year)),
    date_valeur: cleanDateParts(d2, m2, y2),
    reference: code,
    libelle: nature || "Transaction",
    montant_debit: cr ? null : amount,
    montant_credit: cr ? amount : null,
  };
}

// ── bp_split_line — porté EXACTEMENT de bank_statement_parser_BP_ATTIJARI_PROPRE.py ──
function bpSplitLine(line: string): any | null {
  const raw = norm(line);
  let s = raw.replace(/(?<=\d)[lI](?=\d)/g," ").replace(/\//g," ");
  s = norm(s);

  let m = s.match(/^(\d{2})\s+(\d{2})\s+(20\d{2})(\d{0,3})\s+(\d{1,3})?\s*(\d{2})\s+(20\d{2})\s*(.*)$/);
  let d1:string,m1:string,y1:string,d2:string,m2:string,y2:string,rest:string;

  if (m) {
    [,d1,m1,y1,,, m2,y2,rest] = m;
    const d2tail = m[4] || m[5] || "";
    d2 = d2tail.slice(-2) || d1;
  } else {
    const m3 = s.match(/^(\d{2})\s+(\d{2})\s+(20\d{2})\s+(\d{2})\s+(\d{2})\s+(.*)$/);
    if (!m3) return null;
    [,d1,m1,y1,d2,m2,rest] = m3;
    y2 = String(parseInt(m2) > parseInt(m1) ? parseInt(y1)-1 : parseInt(y1));
  }

  const date_op  = cleanDateParts(d1,m1,y1);
  const date_val = cleanDateParts(d2,m2,y2);
  if (!date_op || !date_val) return null;

  // Référence
  let ref = "";
  const restRef = rest.replace(/O/g,"0");
  const rm = restRef.match(/^([A-Z0-9]{4,12})\s*(.*)$/i);
  if (rm) {
    let cand = rm[1].toUpperCase();
    if (!["PAIEMENT","RETRAIT","COMMISSION","TAXE","FRAIS","VIR"].includes(cand)) {
      if (cand.length > 6 && "01519".includes(cand[0])) cand = cand.slice(-6);
      ref = cand;
      rest = norm(rest.slice(rm[1].length));
    }
  }

  const amounts = [...rest.matchAll(new RegExp(AMOUNT_RE_STR,"g"))].map(a => a[0]);
  const amount = amounts.length ? cleanAmount(amounts[amounts.length-1]) : null;
  if (amount === null) return null;

  let nature = rest;
  if (amounts.length) nature = norm(nature.replace(amounts[amounts.length-1],""));

  const cr = looksCredit(nature);
  return {
    ligne: null,
    date_operation: date_op,
    date_valeur: date_val,
    reference: ref,
    libelle: norm(nature) || "Transaction",
    montant_debit: cr ? null : amount,
    montant_credit: cr ? amount : null,
  };
}

// ── awb_soldes — porté EXACTEMENT du Python ──────────────────────────────────────
function awbSoldes(text: string): { solde_initial: number; solde_final: number } {
  const t = norm(text);
  let si = 0, sf = 0;
  const mi = t.match(/SOLDE\s+DEPART\s+AU\s+\d{1,2}\s+\d{1,2}\s+\d{4}\s+(\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2})\s*(CREDITEUR|DEBITEUR)?/i);
  if (mi) { const a = cleanAmount(mi[1])??0; si = (mi[2]||"").toUpperCase().startsWith("DEB") ? -a : a; }
  const mf = t.match(/SOLDE\s+FINAL\s+AU\s+\d{1,2}\s+\d{1,2}\s+\d{4}\s+(\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2})\s*(CREDITEUR|DEBITEUR)?/i);
  if (mf) { const a = cleanAmount(mf[1])??0; sf = (mf[2]||"").toUpperCase().startsWith("DEB") ? -a : a; }
  return { solde_initial: si, solde_final: sf };
}

// ── bp_soldes — porté EXACTEMENT du Python ───────────────────────────────────────
function bpSoldes(text: string): { solde_initial: number; solde_final: number } {
  const t = norm(text);
  let si = 0, sf = 0;
  const mi = t.match(/ANCIEN\s+SOLDE\s+AU?\s*[:.=]?\s*[\d\/\- ]*?(\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2}|\d+[,.]\s*\d{2})/i);
  if (mi) si = cleanAmount(mi[1]) ?? 0;
  const mf = t.match(/SOLDE\s+A\s+REPORTER\s*[:.=]?\s*(\d{1,3}(?:[\s.]?\d{3})*[,.]\s*\d{2}|\d+[,.]\s*\d{2})/i);
  if (mf) sf = cleanAmount(mf[1]) ?? 0;
  return { solde_initial: si, solde_final: sf };
}

// ── PRÉPROCESSEUR : reconstruit les lignes ATW fragmentées par PDF.js ────────────
// PDF.js sépare en colonnes: codes | libellés | dates | montants sur des lignes séparées
// Ce préprocesseur les regroupe AVANT de passer à awbLineToTx
const ATW_CODE_ONLY = /^([A-Z0-9]{5,7})\s+(\d{2})\s+(\d{2})\s*$/;
const ATW_CODE_FULL = /^[A-Z0-9]{5,7}\s+\d{2}\s+\d{2}\s+\S/;
const PURE_DATE_RE  = /^\d{2}\s+\d{2}\s+20\d{2}\s*$/;
const PURE_AMT_RE   = /^\d{1,3}(?:\s\d{3})*,\d{2}\s*$/;

function preprocessATW(lines: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Ligne complète ATW (code + libellé + date + montant) → passer directement
    if (ATW_CODE_FULL.test(line) && new RegExp(AMOUNT_RE_STR).test(line) && /\d{2}\s+\d{2}\s+20\d{2}/.test(line)) {
      result.push(line); i++; continue;
    }

    // Début d'un bloc de codes fragmentés (code seul sur la ligne)
    if (ATW_CODE_ONLY.test(line)) {
      // Collecter tous les codes fragmentés consécutifs
      const fragCodes: [string,string,string][] = [];
      let j = i;
      while (j < lines.length) {
        const mc = ATW_CODE_ONLY.exec(lines[j]);
        if (mc) { fragCodes.push([mc[1], mc[2], mc[3]]); j++; }
        else break;
      }

      // Collecter libellés, dates, montants des lignes suivantes
      const libelles: string[] = [], dates: string[] = [], montants: string[] = [];
      let k = j;
      while (k < lines.length && !ATW_CODE_ONLY.test(lines[k]) && !ATW_CODE_FULL.test(lines[k])) {
        const ln = lines[k].trim();
        if (PURE_DATE_RE.test(ln))       dates.push(ln);
        else if (PURE_AMT_RE.test(ln))   montants.push(ln);
        else if (ln && !/^[\d\s.,:=\-\/]+$/.test(ln)) libelles.push(ln);
        k++;
      }

      // Associer dans l'ordre: code[n] → libelle[n] + date[n] + montant[n]
      fragCodes.forEach(([code,d1,m1], n) => {
        const lib = libelles[n] ?? "Transaction";
        const dat = dates[n]    ?? `${d1} ${m1} ${new Date().getFullYear()}`;
        const amt = montants[n] ?? null;
        if (amt) result.push(`${code} ${d1} ${m1} ${lib} ${dat} ${amt}`);
      });

      i = k; continue;
    }

    result.push(line); i++;
  }
  return result;
}

// ── Parser principal multi-banques ────────────────────────────────────────────────
const EXCL_LINES = /^(?:CODE|DATE\s+OP|LIBELLE|VALEUR|NATURE|REFERENCE|MONTANT|TOTAL\s+MOUVEMENTS|SOLDE\s+(?:DEPART|FINAL|A\s+REPORTER)|ANCIEN\s+SOLDE|NOUVEAU\s+SOLDE|ATTIJARIWAFA\s+BANK|BANQUE\s+POPULAIRE\s+DU|CIH\s+BANK\s+SA|AGENCE\s*:|PAGE\s+\d|RELEVE\s+D.IDENTITE|EXTRAIT\s+DE\s+COMPTE|NOUS\s+AVONS)/i;

function parserRelevePDF(text: string): { txs: any[]; info: InfoReleve } {
  const lower = text.toLowerCase();
  const banque = lower.includes("attijariwafa") ? "Attijariwafa Bank"
    : lower.includes("banque populaire") ? "Banque Populaire"
    : lower.includes("cih") ? "CIH Bank"
    : lower.includes("bmce")||lower.includes("bank of africa") ? "BMCE Bank of Africa"
    : lower.includes("bmci") ? "BMCI"
    : lower.includes("société générale")||lower.includes("societe generale") ? "Société Générale"
    : "Banque";

  const isATW = lower.includes("attijariwafa") || /^[A-Z0-9]{5,7}\s+\d{2}\s+\d{2}/m.test(text);
  const isCIH = lower.includes("cih bank") || lower.includes("cih ");

  console.log(`[PARSER] Banque: ${banque} | isATW: ${isATW} | isCIH: ${isCIH} | lignes total: ${text.split(/\r?\n/).length}`);

  // Soldes
  const soldes = isATW ? awbSoldes(text) : bpSoldes(text);

  // RIB
  const mRib = text.match(/(\d{3})\s+(\d{3})\s+([\d\s]{8,}?)\s+(\d{2})\b/);
  const rib = mRib ? `${mRib[1]} ${mRib[2]} ${mRib[3].trim()} ${mRib[4]}` : "";

  const year = new Date().getFullYear();
  const rawLines = text.split(/\r?\n/).map(l => norm(l)).filter(l => l.length > 1 && !EXCL_LINES.test(l));

  let txs: any[] = [];
  let ligneNum = 1;

  if (isATW) {
    // Préprocesseur: reconstruire lignes fragmentées, PUIS awbLineToTx
    const processedLines = preprocessATW(rawLines);
    for (const line of processedLines) {
      const tx = awbLineToTx(line, year);
      if (tx) { tx.ligne = ligneNum++; txs.push(tx); }
    }
  } else if (isCIH) {
    // CIH: DD/MM/YYYY [REF] LIBELLE MONTANT
    for (const line of rawLines) {
      const amounts = [...line.matchAll(new RegExp(AMOUNT_RE_STR,"g"))].map(a=>a[0]);
      if (!amounts.length) continue;
      const amount = cleanAmount(amounts[amounts.length-1]);
      if (!amount) continue;
      const m1 = line.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(.+?)\s+[\d\s]+,\d{2}\s*$/);
      if (m1) {
        const [,d,mo,y,nat] = m1;
        const nature = cleanNatureText(nat); const cr = looksCredit(nature);
        txs.push({ ligne:ligneNum++, date_operation:`${d}/${mo}/${y}`, date_valeur:`${d}/${mo}/${y}`, reference:"", libelle:nature||"Transaction", montant_debit:cr?null:amount, montant_credit:cr?amount:null });
        continue;
      }
      const m2 = line.match(/^(\d{2})\/(\d{2})\s+(.+?)\s+[\d\s]+,\d{2}\s*$/);
      if (m2) {
        const [,d,mo,nat] = m2;
        if (parseInt(d)>31||parseInt(mo)>12) continue;
        const nature = cleanNatureText(nat); const cr = looksCredit(nature);
        txs.push({ ligne:ligneNum++, date_operation:`${d}/${mo}/${year}`, date_valeur:`${d}/${mo}/${year}`, reference:"", libelle:nature||"Transaction", montant_debit:cr?null:amount, montant_credit:cr?amount:null });
      }
    }
  } else {
    // BP/BMCE/BMCI: bp_split_line avec accumulation (bp_extract_transactions Python)
    let current: any = null;
    const flush = () => {
      if (current && (current.montant_debit != null || current.montant_credit != null)) {
        current.ligne = ligneNum++; txs.push(current);
      }
      current = null;
    };
    const allLines = text.split(/\r?\n/).map(l => norm(l)).filter(l => l.length > 1);
    for (const line of allLines) {
      // Filtrer en-têtes mais PAS les lignes de transactions
      if (/^(?:DATE|LIBELLE|NATURE|REFERENCE|MONTANT|TOTAL\s+MOUVEMENTS|ANCIEN\s+SOLDE|SOLDE\s+A\s+REPORTER|RELEVE\s+D|EXTRAIT\s+DE|NOUS\s+AVONS)/i.test(line)) {
        flush(); continue;
      }
      if (/^(?:SOLDE\s+(?:DEPART|FINAL)|ANCIEN\s+SOLDE)/i.test(line)) { flush(); continue; }
      const tx = bpSplitLine(line);
      if (tx) { flush(); current = tx; continue; }
      if (current) {
        const amounts = [...line.matchAll(new RegExp(AMOUNT_RE_STR,"g"))].map(a => a[0]);
        if (current.montant_debit == null && current.montant_credit == null && amounts.length) {
          const amt = cleanAmount(amounts[amounts.length-1]);
          if (looksCredit(current.libelle)) current.montant_credit = amt;
          else current.montant_debit = amt;
        }
        let cl = line;
        for (const a of amounts) cl = cl.replace(a,"");
        cl = norm(cl);
        if (cl && !/^[\d\s.,:=\-\/]+$/.test(cl)) current.libelle = (current.libelle + " " + cl).trim();
      }
    }
    flush();
  }

  console.log(`[PARSER] ${banque} | ${txs.length} transactions | SI:${soldes.solde_initial} | SF:${soldes.solde_final}`);
  return { txs, info: { banque, rib, solde_initial: soldes.solde_initial, solde_final: soldes.solde_final } };
}

// PCM mapping pour catégories
// PCM_MAP selon CGI Art.106 — TVA déductible ou non au Maroc
const PCM_MAP:Record<string,{code:string;tva:number}>={
  encaissement_client:  {code:"3421",  tva:0},   // Encaissement → pas de TVA
  paiement_fournisseur: {code:"4411",  tva:20},  // Achats fournisseur → TVA 20% déductible
  salaires:             {code:"6171",  tva:0},   // Salaires → hors champ TVA
  cnss_amo:             {code:"6174",  tva:0},   // CNSS/AMO → hors champ TVA (CGI Art.106)
  tva_dgi:              {code:"4456",  tva:0},   // Impôts → pas de TVA sur TVA
  loyers:               {code:"6131",  tva:0},   // Local nu = exonéré; local meublé → modifier manuellement
  eau_electricite:      {code:"6125",  tva:14},  // Électricité 14%, eau 7% → déductible
  telecom:              {code:"6132",  tva:20},  // IAM/Inwi/Orange → TVA 20% déductible
  gasoil:               {code:"61241", tva:0},   // Gasoil véhicules → NON déductible (CGI Art.106)
  assurance:            {code:"6161",  tva:0},   // Assurance → exonérée TVA
  entretien:            {code:"6141",  tva:20},  // Réparations → TVA 20% déductible
  frais_bancaires:      {code:"6347",  tva:10},  // Commissions bancaires → TVA 10% déductible
  taxe_professionnelle: {code:"6313",  tva:0},   // Taxes → pas de TVA
  retrait_especes:      {code:"5161",  tva:0},   // Retrait → pas de TVA
  interets_crediteurs:  {code:"7611",  tva:0},   // Intérêts → hors champ TVA
  frais_representation: {code:"6147",  tva:0},   // Restaurant/réception → NON déductible (CGI Art.106)
  frais_douane:         {code:"6146",  tva:0},   // Droits douane → pas de TVA récupérable
  transport:            {code:"6145",  tva:14},  // Transport marchandises → TVA 14% déductible
  autre:                {code:"6141",  tva:0},   // Divers → par défaut sans TVA
};

const CATEGORIES=[
  {value:"encaissement_client",   label:"Encaissement client"},
  {value:"paiement_fournisseur",  label:"Paiement fournisseur (avec facture)"},
  {value:"salaires",              label:"Salaires"},
  {value:"cnss_amo",              label:"CNSS / AMO (hors TVA)"},
  {value:"tva_dgi",               label:"TVA / IR / IS / DGI"},
  {value:"loyers",                label:"Loyer / Location (local nu → TVA 0%)"},
  {value:"eau_electricite",       label:"Eau / Électricité (TVA déductible)"},
  {value:"telecom",               label:"Téléphone / Internet (TVA 20%)"},
  {value:"gasoil",                label:"Gasoil / Carburant (TVA non déduc.)"},
  {value:"assurance",             label:"Assurance (exonérée TVA)"},
  {value:"entretien",             label:"Entretien / Réparation (TVA 20%)"},
  {value:"frais_bancaires",       label:"Frais bancaires (TVA 10%)"},
  {value:"taxe_professionnelle",  label:"Taxe professionnelle"},
  {value:"retrait_especes",       label:"Retrait espèces / GAB"},
  {value:"interets_crediteurs",   label:"Intérêts créditeurs"},
  {value:"frais_representation",  label:"Restaurant / Réception (TVA non déduc.)"},
  {value:"frais_douane",          label:"Droits de douane / Import"},
  {value:"transport",             label:"Transport marchandises (TVA 14%)"},
  {value:"autre",                 label:"Autre opération"},
];

// ─── Composant ────────────────────────────────────────────────────────────────
function BanquePage() {
  const { dossierId } = Route.useParams();
  const analyserFn = useServerFn(analyserReleveIA);

  const [tab, setTab] = useState<"comptes"|"releves"|"scanner"|"encaissements">("comptes");
  const [comptes, setComptes] = useState<Compte[]>([]);
  const [selectedId, setSelectedId] = useState<string|null>(null);
  const [transactions, setTransactions] = useState<TxBancaire[]>([]);
  const [releves, setReleves] = useState<Releve[]>([]);
  const [facturesNonPayees, setFacturesNonPayees] = useState<FactureNonPayee[]>([]);
  const [facturesClient, setFacturesClient] = useState<any[]>([]);
  const [facturesFourn, setFacturesFourn] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);
  const [dossier, setDossier] = useState<any>(null);

  // Scanner état
  const [scanLoading, setScanLoading] = useState(false);
  const [scanStep, setScanStep] = useState<"idle"|"review"|"done">("idle");
  const [txExtraites, setTxExtraites] = useState<TxExtracted[]>([]);
  const [infoReleve, setInfoReleve] = useState<InfoReleve|null>(null);
  const [releveCompteId, setReleveCompteId] = useState("");
  const [pdfUrl, setPdfUrl] = useState<string|null>(null);
  const [remarques, setRemarques] = useState("");
  const [showRemarques, setShowRemarques] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedTx, setSelectedTx] = useState<number|null>(null);

  // Autres modals
  const [openCompte, setOpenCompte] = useState(false);
  const [openEncaissement, setOpenEncaissement] = useState(false);
  const [processing, setProcessing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [formCompte, setFormCompte] = useState({banque:"",intitule:"",rib:"",iban:"",solde_actuel:0});
  const [formEnc, setFormEnc] = useState({
    type:"especes" as "especes"|"cheque", montant:0,
    date_encaissement:new Date().toISOString().slice(0,10),
    reference:"",numero_cheque:"",banque_cheque:"",libelle:"",
    facture_id:"",facture_fournisseur_id:"",
  });

  const load = async () => {
    const [{data:c},{data:r},{data:fc},{data:ff},{data:fo},{data:cl},{data:dos}]=await Promise.all([
      (supabase.from("comptes_bancaires") as any).select("*").eq("dossier_id",dossierId).order("created_at"),
      (supabase.from("releves_bancaires") as any).select("*").eq("dossier_id",dossierId).order("created_at",{ascending:false}),
      supabase.from("factures").select("id,numero,montant_ttc,montant_ht,montant_tva,montant_paye,montant_restant,type_facture,date_facture,date_echeance,clients(id,nom,ice)").eq("dossier_id",dossierId).eq("statut","conforme").neq("statut_paiement","payee"),
      (supabase as any).from("factures_fournisseurs").select("id,numero,montant_ttc,montant_ht,montant_tva,date_facture,date_echeance,fournisseur_nom").eq("dossier_id",dossierId).neq("statut_paiement","payee"),
      (supabase as any).from("fournisseurs").select("id,nom,ice").eq("dossier_id",dossierId),
      supabase.from("clients").select("id,nom,ice").eq("dossier_id",dossierId),
      (supabase.from("dossiers") as any).select("nom_societe,ice,if_fiscal").eq("id",dossierId).single(),
    ]);
    setComptes((c??[]) as Compte[]);
    setReleves((r??[]) as Releve[]);
    setFacturesClient(fc??[]);
    setFacturesFourn(ff??[]);
    setFournisseurs(fo??[]);
    setClients(cl??[]);
    setDossier((dos as any)??null);
    setFacturesNonPayees([
      ...((fc??[]) as any[]).map((f:any)=>({id:f.id,type:"client" as const,numero:f.numero,nom:(f.clients as any)?.nom??"Client",montant_ttc:Number(f.montant_ttc),date_echeance:f.date_echeance})),
      ...((ff??[]) as any[]).map((f:any)=>({id:f.id,type:"fournisseur" as const,numero:f.numero,nom:f.fournisseur_nom??"Fournisseur",montant_ttc:Number(f.montant_ttc),date_echeance:f.date_echeance})),
    ]);
  };

  const loadTx=async(cid:string)=>{
    const{data}=await (supabase.from("transactions_bancaires") as any).select("*").eq("compte_id",cid).order("date_operation",{ascending:false}).limit(100);
    setTransactions((data??[]) as TxBancaire[]);
  };

  useEffect(()=>{load();},[dossierId]);
  useEffect(()=>{if(selectedId)loadTx(selectedId);},[selectedId]);

  const selected=comptes.find(c=>c.id===selectedId);

  // ── SCANNER RELEVÉ ────────────────────────────────────────────────────────
  const handleReleveUpload=async(file:File)=>{
    if(!releveCompteId){toast.error("Sélectionnez d'abord un compte bancaire");return;}
    setScanLoading(true);
    setPdfUrl(URL.createObjectURL(file));
    try{
      // Extraction PDF
      const pdfjsLib=await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc=`https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
      const ab=await file.arrayBuffer();
      const pdf=await pdfjsLib.getDocument({data:ab}).promise;
      let fullText="";
      for(let i=1;i<=pdf.numPages;i++){
        const page=await pdf.getPage(i);
        const content=await page.getTextContent();
        // CRITIQUE: reconstruction par Y pour vraies lignes
        const items=content.items as any[];
        let lastY=-1,lineText="";
        for(const item of items){
          const y=Math.round(item.transform[5]);
          if(lastY!==-1&&Math.abs(y-lastY)>3){fullText+=lineText.trimEnd()+"\n";lineText="";}
          lineText+=item.str+" ";lastY=y;
        }
        if(lineText.trim()) fullText+=lineText.trimEnd()+"\n";
      }

      // Parser multi-banques
      const{txs:txBrutes,info}=parserRelevePDF(fullText);
      setInfoReleve(info);

      if(txBrutes.length===0){
        toast.error("Aucune transaction détectée. Ce PDF est peut-être une image non OCRisée.");
        setScanLoading(false);return;
      }

      toast.info(`${txBrutes.length} transactions extraites — analyse IA en cours…`);

      // Analyse IA: catégorisation + matching
      const result=await analyserFn({
        data:{
          transactions_brutes:txBrutes,
          factures_client:facturesClient, factures_fourn:facturesFourn,
          clients, fournisseurs,
          dossier_nom:dossier?.nom_societe??"",
          dossier_ice:dossier?.ice??"",
          remarques,
        },
      });

      // Fusionner parser + IA
      const txFinal:TxExtracted[]=txBrutes.map((tx:any,idx:number)=>{
        const a=result.analyses.find((x:any)=>x.i===idx)??result.analyses[idx]??{};
        const cat=a.categorie??"autre";
        const pcm=PCM_MAP[cat]??{code:"6141",tva:0};
        const montant=tx.montant_credit??tx.montant_debit??0;
        const ht=pcm.tva>0?Math.round(montant/(1+pcm.tva/100)*100)/100:montant;
        const tva=pcm.tva>0?Math.round((montant-ht)*100)/100:0;
        return{
          date_operation:tx.date_operation,
          date_valeur:tx.date_valeur,
          reference:tx.reference??"",
          libelle:tx.libelle??"Transaction",
          type:(tx.montant_credit?"credit":"debit") as "credit"|"debit",
          montant:tx.montant_credit??tx.montant_debit??0,
          categorie:cat,
          compte_comptable:a.code_pcm??pcm.code,
          reference_facture:a.facture_num??null,
          confiance:a.confiance??50,
          facture_id:a.facture_id??null,
          alerte:a.alerte??null,
          tiers_nom:a.tiers_nom??null,
          etape_rapprochement:a.etape_rapprochement??"direction",
        };
      });

      setTxExtraites(txFinal);
      setScanStep("review");
      const nbMatch=txFinal.filter(t=>t.facture_id).length;
      toast.success(`${txFinal.length} transactions analysées${nbMatch>0?` — ${nbMatch} matchées avec factures`:""}`);
    }catch(e:any){toast.error("Erreur: "+e.message);}
    finally{setScanLoading(false);}
  };

  const updateTxExtrait=(idx:number,updates:Partial<TxExtracted & {facture_id_manuel?: string}>)=>{
    setTxExtraites(prev=>prev.map((tx,i)=>{
      if(i!==idx) return tx;
      const updated={...tx,...updates};
      if(updates.categorie){
        const pcm=PCM_MAP[updates.categorie]??{code:"6141",tva:0};
        updated.compte_comptable=pcm.code;
      }
      // Si on choisit manuellement une facture
      if(updates.facture_id !== undefined){
        const fClient=facturesClient.find((f:any)=>f.id===updates.facture_id);
        const fFourn=facturesFourn.find((f:any)=>f.id===updates.facture_id);
        if(fClient){ updated.reference_facture=fClient.numero; updated.categorie="encaissement_client"; updated.compte_comptable="3421"; }
        if(fFourn){ updated.reference_facture=fFourn.numero; updated.categorie="paiement_fournisseur"; updated.compte_comptable="4411"; }
      }
      return updated;
    }));
  };

  const handleValiderReleve=async()=>{
    if(!txExtraites.length||!releveCompteId) return;
    setSaving(true);
    try{
      const compte=comptes.find(c=>c.id===releveCompteId);
      let soldeCourant=compte?.solde_actuel??0;

      const txToInsert=txExtraites.map(tx=>({
        compte_id:releveCompteId,dossier_id:dossierId,
        date_operation:tx.date_operation,libelle:tx.libelle,
        type:tx.type,montant:tx.montant,
        solde_apres:0,rapproche:!!tx.facture_id,
      }));

      for(const tx of txToInsert){
        soldeCourant=Math.round((soldeCourant+(tx.type==="credit"?tx.montant:-tx.montant))*100)/100;
        tx.solde_apres=soldeCourant;
      }

      await (supabase.from("transactions_bancaires") as any).insert(txToInsert);
      await (supabase.from("comptes_bancaires") as any).update({solde_actuel:soldeCourant}).eq("id",releveCompteId);

      // ── Écritures comptables PCM correctes ────────────────────────────────
      // RÈGLE: CRÉDIT bancaire (argent reçu) → 5141 DÉBIT / contre-compte CRÉDIT
      //        DÉBIT bancaire (argent sorti)  → 5141 CRÉDIT / contre-compte DÉBIT
      const ecritures:any[]=[];
      const fcPay:string[]=[],ffPay:string[]=[];

      for(const tx of txExtraites){
        const parts=tx.date_operation.split("/");
        const date=parts.length===3&&parts[2].length===4?`${parts[2]}-${parts[1]}-${parts[0]}`:tx.date_operation;
        const libelle=tx.libelle.slice(0,100);
        const pcm=PCM_MAP[tx.categorie]??{code:"6141",tva:0};
        const isCr=tx.type==="credit"; // argent reçu = crédit bancaire
        const montant=tx.montant;

        // TVA récupérable uniquement sur les DÉBITS (achats) avec TVA > 0
        // Pas de TVA sur les encaissements clients (c'est la facture qui porte la TVA)
        const applyTva = !isCr && pcm.tva>0 && tx.categorie!=="encaissement_client";
        const ht  = applyTva ? Math.round(montant/(1+pcm.tva/100)*100)/100 : montant;
        const tva = applyTva ? Math.round((montant-ht)*100)/100 : 0;

        // Écriture 1: compte banque 5141
        // Crédit bancaire (reçu) → 5141 DÉBIT
        // Débit bancaire (sorti) → 5141 CRÉDIT
        ecritures.push({
          dossier_id:dossierId,journal_code:"BQ",compte_numero:"5141",
          date_ecriture:date,libelle,
          debit:isCr?montant:0,
          credit:isCr?0:montant,
          reference_piece:tx.reference_facture||tx.reference,valide:true,
        });

        // Écriture 2: contre-compte PCM
        if(applyTva){
          // Charge HT
          ecritures.push({
            dossier_id:dossierId,journal_code:"BQ",compte_numero:pcm.code,
            date_ecriture:date,libelle,
            debit:ht,credit:0,  // charge = débit
            reference_piece:tx.reference_facture,valide:true,
          });
          // TVA déductible 34552
          ecritures.push({
            dossier_id:dossierId,journal_code:"BQ",compte_numero:"34552",
            date_ecriture:date,libelle:`TVA ${libelle.slice(0,50)}`,
            debit:tva,credit:0,
            reference_piece:tx.reference_facture,valide:true,
          });
        } else if(isCr && tx.categorie==="encaissement_client"){
          // Encaissement client: 3421 CRÉDIT (client solde sa dette)
          ecritures.push({
            dossier_id:dossierId,journal_code:"BQ",compte_numero:"3421",
            date_ecriture:date,libelle,
            debit:0,credit:montant,
            reference_piece:tx.reference_facture,valide:true,
          });
        } else if(!isCr && tx.categorie==="paiement_fournisseur"){
          // Paiement fournisseur: 4411 DÉBIT (on solde notre dette)
          ecritures.push({
            dossier_id:dossierId,journal_code:"BQ",compte_numero:"4411",
            date_ecriture:date,libelle,
            debit:montant,credit:0,
            reference_piece:tx.reference_facture,valide:true,
          });
        } else if(!isCr && tx.categorie==="retrait_especes"){
          // Retrait: 5141 CRÉDIT (déjà fait) + 5161 DÉBIT (caisse augmente)
          ecritures.push({
            dossier_id:dossierId,journal_code:"BQ",compte_numero:"5161",
            date_ecriture:date,libelle,
            debit:montant,credit:0,
            reference_piece:tx.reference,valide:true,
          });
        } else if(!isCr){
          // Autres charges sans TVA: compte charge DÉBIT
          ecritures.push({
            dossier_id:dossierId,journal_code:"BQ",compte_numero:pcm.code,
            date_ecriture:date,libelle,
            debit:montant,credit:0,
            reference_piece:tx.reference_facture,valide:true,
          });
        } else {
          // Autres crédits (intérêts, etc.): contre-compte CRÉDIT
          ecritures.push({
            dossier_id:dossierId,journal_code:"BQ",compte_numero:pcm.code,
            date_ecriture:date,libelle,
            debit:0,credit:montant,
            reference_piece:tx.reference_facture,valide:true,
          });
        }

        // Rapprochement factures
        if(tx.facture_id){
          const isClientFac=facturesClient.some((f:any)=>f.id===tx.facture_id);
          const isFournFac=facturesFourn.some((f:any)=>f.id===tx.facture_id);
          if(isClientFac&&isCr) fcPay.push(tx.facture_id);
          else if(isFournFac&&!isCr) ffPay.push(tx.facture_id);
        }
      }

      await supabase.from("ecritures_comptables").insert(ecritures);
      // Mise à jour statut: partielle si montant payé < montant total, payee sinon
      for(const fid of fcPay){
        const fac=facturesClient.find((f:any)=>f.id===fid);
        const tx=txExtraites.find(t=>t.facture_id===fid);
        const montantPaye=Math.round(((tx?.montant??0)+(Number(fac?.montant_paye)||0))*100)/100;
        const montantTotal=Number(fac?.montant_ttc)||0;
        const estPaye=montantPaye>=montantTotal-0.01;
        await (supabase.from("factures") as any).update({
          statut_paiement:estPaye?"payee":"partielle",
          montant_paye:montantPaye,
          montant_restant:Math.max(0,Math.round((montantTotal-montantPaye)*100)/100),
          date_paiement:new Date().toISOString().slice(0,10),
        }).eq("id",fid);
      }
      for(const fid of ffPay){
        const fac=facturesFourn.find((f:any)=>f.id===fid);
        const tx=txExtraites.find(t=>t.facture_id===fid);
        const montantPaye=Math.round(((tx?.montant??0)+(Number(fac?.montant_paye)||0))*100)/100;
        const montantTotal=Number(fac?.montant_ttc)||0;
        const estPaye=montantPaye>=montantTotal-0.01;
        await (supabase.from("factures_fournisseurs") as any).update({
          statut_paiement:estPaye?"payee":"partielle",
          montant_paye:montantPaye,
          montant_restant:Math.max(0,Math.round((montantTotal-montantPaye)*100)/100),
          date_paiement:new Date().toISOString().slice(0,10),
        }).eq("id",fid);
      }

      await (supabase.from("releves_bancaires") as any).insert({
        compte_id:releveCompteId,dossier_id:dossierId,
        nombre_transactions:txExtraites.length,
        solde_initial:compte?.solde_actuel??0,
        solde_final:soldeCourant,statut:"valide",
        fichier_nom:"relevé importé",
      });

      const nbPay=fcPay.length+ffPay.length;
      toast.success(`${txExtraites.length} transactions enregistrées + écritures PCM correctes`+(nbPay>0?` — ${nbPay} facture(s) payée(s)`:""));
      setScanStep("done");
      load();
      if(selectedId) loadTx(selectedId);
    }catch(e:any){toast.error(e.message);}
    finally{setSaving(false);}
  };

    // ── Génération EDI DGI — format Relevé de Déduction (ADC082F-15I) ──────────────
  const genererEDI=async()=>{
    // Comptes avec TVA déductible UNIQUEMENT (hors 6147 représentation, 6174 CNSS, 4456 TVA/DGI)
    const COMPTES_TVA_DEDUCTIBLE=["4411","6122","6125","6131","6132","6141","6145","6146"];
    const txEligibles=txExtraites.filter(tx=>{
      const pcm=PCM_MAP[tx.categorie]??{code:"6141",tva:0};
      return tx.type==="debit"
        && pcm.tva>0
        && COMPTES_TVA_DEDUCTIBLE.includes(pcm.code);
    });
    if(!txEligibles.length){ toast.warning("Aucune transaction éligible à la déduction TVA"); return; }

    const dossierInfo=dossier??{nom_societe:"",ice:"",if_fiscal:""};
    const annee=new Date().getFullYear();
    const mois=new Date().getMonth()+1;

    const toExcelDate=(dateStr:string):number=>{
      const parts=dateStr.split("/");
      if(parts.length!==3) return 0;
      const d=new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
      const start=new Date("1899-12-30");
      return Math.round((d.getTime()-start.getTime())/86400000);
    };

    // Construire les données
    const dataRows:any[][]=[];
    let totalHT=0,totalTVA=0,totalTTC=0;

    txEligibles.forEach((tx,i)=>{
      const pcm=PCM_MAP[tx.categorie]??{code:"6141",tva:20};
      const ht=Math.round(tx.montant/(1+pcm.tva/100)*100)/100;
      const tva=Math.round((tx.montant-ht)*100)/100;
      // Chercher fournisseur par nom tiers
      const fourn=tx.tiers_nom
        ?(fournisseurs as any[]).find(f=>f.nom&&f.nom.toUpperCase().includes((tx.tiers_nom||"").toUpperCase().slice(0,5)))
        :null;
      const facFourn=tx.facture_id?(facturesFourn as any[]).find(f=>f.id===tx.facture_id):null;
      const datePaieExcel=toExcelDate(tx.date_operation);
      const dateFacExcel=facFourn
        ?toExcelDate((facFourn.date_facture||"").split("-").reverse().join("/"))
        :datePaieExcel;
      totalHT+=ht; totalTVA+=tva; totalTTC+=tx.montant;
      dataRows.push([
        i+1,
        tx.reference_facture||facFourn?.numero||`TX-${i+1}`,
        tx.libelle.slice(0,50),
        Math.round(ht*100)/100,
        Math.round(tva*100)/100,
        tx.montant,
        fourn?.if_fiscal||"",
        tx.tiers_nom||fourn?.nom||"",
        fourn?.ice||"",
        pcm.tva,
        i+1,
        datePaieExcel,
        dateFacExcel,
      ]);
    });

    // Générer Excel avec SheetJS
    const XLSX=await import("xlsx");
    const wb=XLSX.utils.book_new();

    // Feuille en-tête DGI
    const headerData=[
      ["RAISON SOCIAL","",dossierInfo.nom_societe||""],
      ["ID_FISCAL","",(dossierInfo as any).if_fiscal||""],
      ["ANNEE","",annee],
      [`PERIODE(Mois)`,"",mois,"","","Relevé de déduction"],
      ["REGIME(Encais-1)","",1],
      [],
      ["OR","FACT_NUM","DESIGNATION","M_HT","TVA","M_TTC","IF","LIB_FRSS","ICE_FRS","TAUX","ID_PAIE","DATE_PAIE","DATE_FAC"],
      ...dataRows,
      ["Total","","",Math.round(totalHT*100)/100,Math.round(totalTVA*100)/100,Math.round(totalTTC*100)/100],
    ];

    const ws=XLSX.utils.aoa_to_sheet(headerData);

    // Style colonnes
    ws['!cols']=[
      {wch:6},{wch:15},{wch:45},{wch:12},{wch:10},{wch:12},
      {wch:12},{wch:30},{wch:18},{wch:8},{wch:8},{wch:12},{wch:12},
    ];

    // Formater les colonnes DATE comme date Excel (DATE_PAIE=col L, DATE_FAC=col M)
    const dateColL=XLSX.utils.encode_col(11); // L = DATE_PAIE
    const dateColM=XLSX.utils.encode_col(12); // M = DATE_FAC
    dataRows.forEach((_,i)=>{
      const row=i+8; // ligne données commence à 8 (après 7 lignes entête)
      const cellL=`${dateColL}${row}`;
      const cellM=`${dateColM}${row}`;
      if(ws[cellL]) ws[cellL].t="n";
      if(ws[cellM]) ws[cellM].t="n";
      if(!ws['!formats']) (ws as any)['!formats']={};
    });

    XLSX.utils.book_append_sheet(wb,ws,"Relevé Déduction");
    const nom=`EDI_DGI_${(dossierInfo.nom_societe||"export").replace(/\s/g,"_")}_${annee}_${String(mois).padStart(2,"0")}.xlsx`;
    XLSX.writeFile(wb,nom);
    toast.success(`EDI DGI Excel généré — ${txEligibles.length} lignes | HT: ${Math.round(totalHT).toLocaleString("fr-MA")} MAD | TVA: ${Math.round(totalTVA).toLocaleString("fr-MA")} MAD`);
  };


  const genererBilan=()=>{
    const rows=[["Date","Journal","Compte","Libellé","Débit","Crédit","Catégorie","Réf."]];
    for(const tx of txExtraites){
      const pcm=PCM_MAP[tx.categorie]??{code:"6141",tva:0};
      const ht=pcm.tva>0?Math.round(tx.montant/(1+pcm.tva/100)*100)/100:tx.montant;
      rows.push([tx.date_operation,"BQ","5141",tx.libelle,tx.type==="credit"?String(tx.montant):"",tx.type==="debit"?String(tx.montant):"",tx.categorie,tx.reference_facture||""]);
      rows.push([tx.date_operation,"BQ",tx.compte_comptable,tx.libelle,tx.type==="debit"?String(ht):"",tx.type==="credit"?String(ht):"",tx.categorie,tx.reference_facture||""]);
    }
    const blob=new Blob(["\uFEFF"+rows.map(r=>r.join(";")).join("\n")],{type:"text/csv;charset=utf-8;"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`Bilan_BQ_${new Date().toISOString().slice(0,10)}.csv`;a.click();
    toast.success("Bilan Sage généré");
  };

  const resetScan=()=>{setScanStep("idle");setTxExtraites([]);setInfoReleve(null);setPdfUrl(null);setSelectedTx(null);};

  // ── Encaissement (code original préservé) ─────────────────────────────────
  const handleEncaissement=async()=>{
    if(!formEnc.montant||!formEnc.date_encaissement) return toast.error("Montant et date requis");
    setProcessing(true);
    try{
      const{error}=await (supabase as any).from("encaissements").insert({
        dossier_id:dossierId,type:formEnc.type,montant:formEnc.montant,
        date_encaissement:formEnc.date_encaissement,reference:formEnc.reference||null,
        numero_cheque:formEnc.numero_cheque||null,banque_cheque:formEnc.banque_cheque||null,
        libelle:formEnc.libelle||null,facture_id:formEnc.facture_id||null,
        facture_fournisseur_id:formEnc.facture_fournisseur_id||null,valide:true,
      });
      if(error) throw error;
      const journalCode=formEnc.type==="especes"?"CAI":"BQ";
      const compteDebit=formEnc.type==="especes"?"5161":"5141";
      const compteContre=formEnc.facture_id?"3421":formEnc.facture_fournisseur_id?"4411":"7111";
      await supabase.from("ecritures_comptables").insert([
        {dossier_id:dossierId,journal_code:journalCode,compte_numero:compteDebit,date_ecriture:formEnc.date_encaissement,libelle:formEnc.libelle||`Encaissement ${formEnc.type}`,debit:formEnc.montant,credit:0,reference_piece:formEnc.reference||null,valide:true},
        {dossier_id:dossierId,journal_code:journalCode,compte_numero:compteContre,date_ecriture:formEnc.date_encaissement,libelle:formEnc.libelle||"Règlement",debit:0,credit:formEnc.montant,reference_piece:formEnc.reference||null,valide:true},
      ]);
      if(formEnc.facture_id) await (supabase.from("factures") as any).update({statut_paiement:"payee",date_paiement:formEnc.date_encaissement}).eq("id",formEnc.facture_id);
      if(formEnc.facture_fournisseur_id) await (supabase as any).from("factures_fournisseurs").update({statut_paiement:"payee",date_paiement:formEnc.date_encaissement}).eq("id",formEnc.facture_fournisseur_id);
      toast.success("Encaissement enregistré + écriture créée");
      setOpenEncaissement(false);
      setFormEnc({type:"especes",montant:0,date_encaissement:new Date().toISOString().slice(0,10),reference:"",numero_cheque:"",banque_cheque:"",libelle:"",facture_id:"",facture_fournisseur_id:""});
      load();
    }catch(e:any){toast.error(e.message);}
    finally{setProcessing(false);}
  };

  const confColor=(c:number)=>c>=90?"text-green-600":c>=70?"text-yellow-500":"text-red-500";
  const getCatLabel=(v:string)=>CATEGORIES.find(c=>c.value===v)?.label??v;
  const totalCr=txExtraites.reduce((s,t)=>s+(t.type==="credit"?t.montant:0),0);
  const totalDb=txExtraites.reduce((s,t)=>s+(t.type==="debit"?t.montant:0),0);
  const nbMatch=txExtraites.filter(t=>t.facture_id).length;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Banque & Trésorerie</h1>
          <p className="text-muted-foreground mt-1">Relevés bancaires · Rapprochement auto · Encaissements espèces/chèques</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={()=>setOpenEncaissement(true)}>
            <FileText className="h-4 w-4 mr-2"/>Encaissement espèces/chèque
          </Button>
          <Button onClick={()=>setOpenCompte(true)}>
            <Plus className="h-4 w-4 mr-2"/>Compte bancaire
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={v=>setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="comptes">Comptes ({comptes.length})</TabsTrigger>
          <TabsTrigger value="releves">Relevés importés ({releves.length})</TabsTrigger>
          <TabsTrigger value="scanner">
            📄 Scanner relevé
            {facturesNonPayees.length>0&&<span className="ml-2 bg-orange-500 text-white text-xs px-1.5 py-0.5 rounded-full">{facturesNonPayees.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="encaissements">Encaissements espèces/chèques</TabsTrigger>
        </TabsList>

        {/* ── COMPTES ── */}
        <TabsContent value="comptes" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            {comptes.length===0?(
              <Card className="col-span-3"><CardContent className="py-12 text-center text-muted-foreground">
                <Landmark className="h-10 w-10 mx-auto mb-2 opacity-30"/>
                <p>Aucun compte bancaire — créez-en un</p>
              </CardContent></Card>
            ):comptes.map(c=>(
              <Card key={c.id} className={`cursor-pointer transition-all ${selectedId===c.id?"ring-2 ring-primary":"hover:shadow-md"}`}
                onClick={()=>setSelectedId(c.id===selectedId?null:c.id)}>
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-muted-foreground">{c.banque}</span>
                    <Landmark className="h-4 w-4 text-muted-foreground"/>
                  </div>
                  <p className="font-semibold">{c.intitule}</p>
                  <p className="font-mono text-xs text-muted-foreground mt-1">{c.rib}</p>
                  <p className={`text-2xl font-bold mt-3 ${c.solde_actuel>=0?"text-green-600":"text-red-600"}`}>{fmt(c.solde_actuel)}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          {selectedId&&(
            <>
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold">Transactions — {selected?.intitule}</h2>
                <Button size="sm" onClick={()=>{setReleveCompteId(selectedId);setTab("scanner");}}>
                  <Upload className="h-3 w-3 mr-1"/>Importer relevé
                </Button>
              </div>
              <Card><CardContent className="p-0">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Date</TableHead><TableHead>Libellé</TableHead><TableHead>Type</TableHead>
                    <TableHead className="text-right">Montant</TableHead><TableHead className="text-right">Solde</TableHead><TableHead>Rapproché</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {transactions.length===0
                      ?<TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Importez un relevé dans l'onglet "Scanner relevé"</TableCell></TableRow>
                      :transactions.map(t=>(
                        <TableRow key={t.id}>
                          <TableCell className="text-sm">{new Date(t.date_operation).toLocaleDateString("fr-MA")}</TableCell>
                          <TableCell className="text-sm max-w-[250px] truncate">{t.libelle}</TableCell>
                          <TableCell>
                            <Badge className={t.type==="credit"?"bg-green-100 text-green-700":"bg-red-100 text-red-700"}>
                              {t.type==="credit"?<TrendingUp className="h-3 w-3 mr-1"/>:<TrendingDown className="h-3 w-3 mr-1"/>}{t.type}
                            </Badge>
                          </TableCell>
                          <TableCell className={`text-right font-mono text-sm ${t.type==="credit"?"text-green-600":"text-red-600"}`}>
                            {t.type==="credit"?"+":"-"}{fmt(t.montant)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">{t.solde_apres!=null?fmt(t.solde_apres):"—"}</TableCell>
                          <TableCell>
                            {t.rapproche
                              ?<Badge className="bg-green-100 text-green-700 text-xs"><CheckCircle className="h-3 w-3 mr-1"/>Oui</Badge>
                              :<Badge variant="secondary" className="text-xs">Non</Badge>}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </CardContent></Card>
            </>
          )}
        </TabsContent>

        {/* ── RELEVÉS ── */}
        <TabsContent value="releves" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Fichier</TableHead><TableHead>Compte</TableHead>
                <TableHead>Transactions</TableHead><TableHead>Solde final</TableHead><TableHead>Statut</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {releves.length===0
                  ?<TableRow><TableCell colSpan={5} className="text-center py-10 text-muted-foreground">Aucun relevé importé — utilisez l'onglet "Scanner relevé"</TableCell></TableRow>
                  :releves.map(r=>(
                    <TableRow key={r.id}>
                      <TableCell className="text-sm">{r.fichier_nom??"Relevé"}</TableCell>
                      <TableCell className="text-sm">{comptes.find(c=>c.id===(r as any).compte_id)?.intitule??"—"}</TableCell>
                      <TableCell className="font-mono text-sm">{r.nombre_transactions}</TableCell>
                      <TableCell className="font-mono text-sm">{fmt(Number(r.solde_final))}</TableCell>
                      <TableCell><Badge variant={(r.statut as any)==="valide"?"default":"secondary"}>{(r.statut as any)==="valide"?"✅ Validé":r.statut}</Badge></TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        {/* ── SCANNER ── */}
        <TabsContent value="scanner" className="mt-4">
          {scanStep==="idle"&&(
            <div className="space-y-4">
              {facturesNonPayees.length>0&&(
                <Card className="border-orange-200">
                  <CardContent className="pt-4 pb-4">
                    <p className="font-medium text-sm mb-2 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-orange-500"/>
                      {facturesNonPayees.length} facture(s) en attente de paiement — matching automatique
                    </p>
                    <div className="space-y-1">
                      {facturesNonPayees.slice(0,5).map(f=>(
                        <div key={f.id} className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>{f.type==="client"?"📤":"📥"} {f.nom} — {f.numero}</span>
                          <span className="font-mono font-semibold">{fmt(f.montant_ttc)}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="space-y-2">
                <Label>Compte bancaire *</Label>
                <Select value={releveCompteId} onValueChange={setReleveCompteId}>
                  <SelectTrigger className="max-w-sm"><SelectValue placeholder="Sélectionner le compte…"/></SelectTrigger>
                  <SelectContent>{comptes.map(c=><SelectItem key={c.id} value={c.id}>{c.intitule} — {c.banque}</SelectItem>)}</SelectContent>
                </Select>
              </div>

              <div className="border-2 border-dashed rounded-xl p-12 text-center cursor-pointer hover:border-primary transition-colors max-w-2xl"
                onClick={()=>fileRef.current?.click()}
                onDragOver={e=>e.preventDefault()}
                onDrop={e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f)handleReleveUpload(f);}}>
                <input ref={fileRef} type="file" className="hidden" accept=".pdf"
                  onChange={e=>{const f=e.target.files?.[0];if(f)handleReleveUpload(f);}}/>
                {scanLoading
                  ?<><Loader2 className="h-10 w-10 animate-spin mx-auto text-primary mb-2"/><p className="font-medium">Extraction + Analyse IA en cours…</p><p className="text-xs text-muted-foreground mt-1">Parser multi-banques → Gemini/Groq catégorisation + matching factures</p></>
                  :<><Upload className="h-10 w-10 mx-auto mb-2 text-muted-foreground"/><p className="font-medium text-lg">Glissez votre relevé bancaire PDF</p><p className="text-sm text-muted-foreground mt-1">Attijariwafa · Banque Populaire · CIH · BMCE · BMCI · Société Générale</p><p className="text-xs text-muted-foreground mt-2 opacity-70">Extraction automatique + matching factures + codes PCM marocains</p></>
                }
              </div>
            </div>
          )}

          {scanStep==="review"&&(
            <div className="space-y-4">
              {/* Header stats */}
              <div className="flex items-center justify-between">
                <div className="flex gap-3">
                  <Badge variant="outline">{txExtraites.length} transactions</Badge>
                  <Badge className="bg-green-600">+{fmt(totalCr)}</Badge>
                  <Badge className="bg-red-600">-{fmt(totalDb)}</Badge>
                  {nbMatch>0&&<Badge className="bg-blue-600">🔗 {nbMatch} matchées</Badge>}
                  {infoReleve&&<Badge variant="outline">{infoReleve.banque}</Badge>}
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={()=>setShowRemarques(true)}><RefreshCw className="h-3.5 w-3.5 mr-1.5"/>Rescanner</Button>
                  <Button variant="outline" size="sm" onClick={genererEDI}><Download className="h-3.5 w-3.5 mr-1.5"/>EDI DGI</Button>
              <Button variant="outline" size="sm" onClick={genererBilan}><Download className="h-3.5 w-3.5 mr-1.5"/>Bilan Sage</Button>
                  <Button size="sm" onClick={handleValiderReleve} disabled={saving}>
                    {saving?<Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin"/>:<CheckCircle className="h-3.5 w-3.5 mr-1.5"/>}
                    Valider et enregistrer
                  </Button>
                  <Button variant="ghost" size="sm" onClick={resetScan}><X className="h-3.5 w-3.5"/></Button>
                </div>
              </div>

              {/* Soldes */}
              {infoReleve&&(
                <div className="grid grid-cols-4 gap-3">
                  {[
                    {label:"Banque",value:infoReleve.banque,color:"text-primary"},
                    {label:"RIB",value:infoReleve.rib||"—",color:"text-muted-foreground"},
                    {label:"Solde initial",value:fmt(infoReleve.solde_initial),color:"text-blue-600"},
                    {label:"Solde final",value:fmt(infoReleve.solde_final),color:"text-blue-700"},
                  ].map(k=>(
                    <Card key={k.label} className="border-0 bg-muted/40">
                      <CardContent className="pt-3 pb-3">
                        <p className="text-[10px] text-muted-foreground uppercase">{k.label}</p>
                        <p className={`font-semibold text-sm mt-0.5 ${k.color}`}>{k.value}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              {/* Tableau transactions */}
              <Card><CardContent className="p-0">
                <div className="max-h-[500px] overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card z-10">
                      <TableRow>
                        <TableHead className="w-8">#</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Libellé</TableHead>
                        <TableHead>Catégorie / Code PCM</TableHead>
                        <TableHead className="text-right">Montant</TableHead>
                        <TableHead>Facture correspondante</TableHead>
                        <TableHead className="w-8"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {txExtraites.map((tx,idx)=>{
                        const fClientOptions=facturesClient.map((f:any)=>({id:f.id,label:`${f.numero??f.id.slice(0,8)} — ${f.clients?.nom??""} — ${fmt(Number(f.montant_ttc))}`}));
                        const fFournOptions=facturesFourn.map((f:any)=>({id:f.id,label:`${f.numero??f.id.slice(0,8)} — ${f.fournisseur_nom??""} — ${fmt(Number(f.montant_ttc))}`}));
                        const facOptions=tx.type==="credit"?fClientOptions:fFournOptions;
                        const facChoisie=tx.type==="credit"
                          ?facturesClient.find((f:any)=>f.id===tx.facture_id)
                          :facturesFourn.find((f:any)=>f.id===tx.facture_id);
                        const etapeLabel:Record<string,string>={
                          remarques:"📋 Remarques",numero_facture:"🔢 N° facture",
                          nom_tiers:"👤 Nom tiers",montant_date:"💰 Montant",
                          mots_cles:"🔑 Mots-clés",direction:"↕️ Direction",inconnu:"❓ Inconnu"
                        };
                        return(
                        <>
                          <TableRow key={idx}
                            className={`cursor-pointer ${selectedTx===idx?"bg-primary/5":""} ${tx.facture_id?"border-l-2 border-l-green-500":tx.alerte?"border-l-2 border-l-orange-400":""}`}
                            onClick={()=>setSelectedTx(selectedTx===idx?null:idx)}>
                            <TableCell className="text-xs text-muted-foreground">{idx+1}</TableCell>
                            <TableCell className="text-xs font-mono">{tx.date_operation}</TableCell>
                            <TableCell className="text-sm max-w-[180px]">
                              <p className="truncate font-medium">{tx.libelle}</p>
                              {tx.tiers_nom&&<p className="text-[10px] text-blue-600">👤 {tx.tiers_nom}</p>}
                              {tx.alerte&&<p className="text-[10px] text-orange-600">⚠️ {tx.alerte}</p>}
                            </TableCell>
                            <TableCell onClick={e=>e.stopPropagation()}>
                              <Select value={tx.categorie} onValueChange={v=>updateTxExtrait(idx,{categorie:v})}>
                                <SelectTrigger className="h-7 text-xs w-44">
                                  <div className="flex items-center gap-1">
                                    <span className={`text-xs ${confColor(tx.confiance)}`}>●</span>
                                    <span className="truncate">{getCatLabel(tx.categorie)}</span>
                                  </div>
                                </SelectTrigger>
                                <SelectContent>
                                  {CATEGORIES.map(c=><SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>)}
                                </SelectContent>
                              </Select>
                              <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{tx.compte_comptable} · {etapeLabel[tx.etape_rapprochement]??tx.etape_rapprochement}</p>
                            </TableCell>
                            <TableCell className={`text-right font-mono text-sm font-semibold ${tx.type==="credit"?"text-green-600":"text-red-600"}`}>
                              {tx.type==="credit"?"+":"-"}{fmt(tx.montant)}
                            </TableCell>
                            <TableCell onClick={e=>e.stopPropagation()} className="min-w-[200px]">
                              <Select
                                value={tx.facture_id??"none"}
                                onValueChange={v=>updateTxExtrait(idx,{facture_id:v==="none"?null:v})}>
                                <SelectTrigger className={`h-7 text-xs ${tx.facture_id?"border-green-400 bg-green-50":"border-orange-300 bg-orange-50"}`}>
                                  <div className="flex items-center gap-1 overflow-hidden">
                                    {tx.facture_id
                                      ?<><span className="text-green-600">🔗</span><span className="truncate text-green-700">{tx.reference_facture||"Facture matchée"}</span></>
                                      :<><span className="text-orange-500">⚠️</span><span className="truncate text-orange-600">Aucune facture — choisir</span></>
                                    }
                                  </div>
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none" className="text-xs text-muted-foreground">Aucune facture liée</SelectItem>
                                  {facOptions.map(f=>(
                                    <SelectItem key={f.id} value={f.id} className="text-xs">{f.label}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {tx.facture_id&&<p className="text-[10px] text-green-600 mt-0.5">Confiance: {tx.confiance}%</p>}
                            </TableCell>
                            <TableCell onClick={e=>e.stopPropagation()}>
                              {tx.facture_id&&facChoisie&&(
                                <Button size="sm" variant="ghost" className="h-6 w-6 p-0"
                                  onClick={()=>window.open((facChoisie as any).fichier_original_url??"#","_blank")}
                                  title="Voir la facture">
                                  <Eye className="h-3 w-3"/>
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                          {selectedTx===idx&&(
                            <TableRow key={`${idx}-detail`}>
                              <TableCell colSpan={7} className="bg-muted/30 p-3">
                                <div className="grid grid-cols-4 gap-3 text-xs">
                                  <div><p className="text-muted-foreground mb-1">Référence</p><p className="font-mono">{tx.reference||"—"}</p></div>
                                  <div><p className="text-muted-foreground mb-1">Date valeur</p><p className="font-mono">{tx.date_valeur}</p></div>
                                  <div><p className="text-muted-foreground mb-1">Confiance IA</p><p className={`font-semibold ${confColor(tx.confiance)}`}>{tx.confiance}%</p></div>
                                  <div><p className="text-muted-foreground mb-1">Méthode match</p><p>{etapeLabel[tx.etape_rapprochement]??tx.etape_rapprochement}</p></div>
                                  {tx.facture_id&&<div className="col-span-4"><p className="text-green-700">✅ Facture: {tx.reference_facture} — {tx.tiers_nom}</p></div>}
                                  {!tx.facture_id&&<div className="col-span-4"><p className="text-orange-600">⚠️ {tx.alerte||"Aucune facture correspondante détectée — choisissez dans la liste déroulante"}</p></div>}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent></Card>
            </div>
          )}

          {scanStep==="done"&&(
            <div className="text-center py-16">
              <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4"/>
              <h2 className="text-xl font-bold mb-2">Relevé enregistré avec succès</h2>
              <p className="text-muted-foreground mb-6">{txExtraites.length} transactions · Écritures PCM créées · Factures mises à jour</p>
              <div className="flex gap-3 justify-center">
                <Button variant="outline" onClick={genererEDI}><Download className="h-4 w-4 mr-2"/>EDI DGI</Button>
              <Button variant="outline" onClick={genererBilan}><Download className="h-4 w-4 mr-2"/>Bilan Sage</Button>
                <Button onClick={()=>{resetScan();setTab("comptes");}}>Voir les transactions</Button>
                <Button variant="outline" onClick={resetScan}>Nouveau relevé</Button>
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── ENCAISSEMENTS ── */}
        <TabsContent value="encaissements" className="mt-4">
          <div className="mb-4 p-4 bg-muted rounded-lg text-sm">
            <p className="font-medium mb-1">Encaissements hors virement bancaire</p>
            <p className="text-muted-foreground">Espèces ou chèque — enregistrés dans le journal de caisse (5161) ou banque (5141).</p>
          </div>
          <Button onClick={()=>setOpenEncaissement(true)}><Plus className="h-4 w-4 mr-2"/>Saisir un encaissement</Button>
        </TabsContent>
      </Tabs>

      {/* Modal rescanner */}
      <Dialog open={showRemarques} onOpenChange={setShowRemarques}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Rescanner avec remarques</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Précisions pour améliorer la catégorisation :</p>
            <textarea value={remarques} onChange={e=>setRemarques(e.target.value)}
              placeholder="Ex : FIRSTAUM = loyer bureau, CNSS le 10 du mois, ATLAS = fournisseur emballage…"
              rows={4} className="w-full text-sm border rounded p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"/>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setShowRemarques(false)}>Annuler</Button>
            <Button onClick={()=>{setShowRemarques(false);fileRef.current?.click();}}>
              <Sparkles className="h-4 w-4 mr-2"/>Rescanner
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal encaissement (code original) */}
      <Dialog open={openEncaissement} onOpenChange={setOpenEncaissement}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Encaissement espèces / chèque</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label>Type *</Label>
              <Select value={formEnc.type} onValueChange={v=>setFormEnc({...formEnc,type:v as "especes"|"cheque"})}>
                <SelectTrigger><SelectValue/></SelectTrigger>
                <SelectContent><SelectItem value="especes">💵 Espèces</SelectItem><SelectItem value="cheque">🏦 Chèque</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Montant (MAD) *</Label><Input type="number" step="0.01" value={formEnc.montant} onChange={e=>setFormEnc({...formEnc,montant:parseFloat(e.target.value)||0})}/></div>
              <div className="space-y-2"><Label>Date *</Label><Input type="date" value={formEnc.date_encaissement} onChange={e=>setFormEnc({...formEnc,date_encaissement:e.target.value})}/></div>
            </div>
            {formEnc.type==="cheque"&&(
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>N° chèque</Label><Input value={formEnc.numero_cheque} onChange={e=>setFormEnc({...formEnc,numero_cheque:e.target.value})}/></div>
                <div className="space-y-2"><Label>Banque</Label><Input value={formEnc.banque_cheque} onChange={e=>setFormEnc({...formEnc,banque_cheque:e.target.value})}/></div>
              </div>
            )}
            <div className="space-y-2"><Label>Libellé</Label><Input value={formEnc.libelle} onChange={e=>setFormEnc({...formEnc,libelle:e.target.value})} placeholder="Paiement facture F2026-001…"/></div>
            <div className="space-y-2">
              <Label>Facture concernée (optionnel)</Label>
              <Select value={formEnc.facture_id||formEnc.facture_fournisseur_id||"none"}
                onValueChange={v=>{
                  if(v==="none"){setFormEnc({...formEnc,facture_id:"",facture_fournisseur_id:""});return;}
                  const f=facturesNonPayees.find(f=>f.id===v);
                  if(f?.type==="client") setFormEnc({...formEnc,facture_id:v,facture_fournisseur_id:"",montant:f.montant_ttc});
                  else if(f?.type==="fournisseur") setFormEnc({...formEnc,facture_fournisseur_id:v,facture_id:"",montant:f.montant_ttc});
                }}>
                <SelectTrigger><SelectValue placeholder="Aucune facture liée"/></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Aucune facture liée</SelectItem>
                  {facturesNonPayees.map(f=>(<SelectItem key={f.id} value={f.id}>{f.type==="client"?"📤":"📥"} {f.nom} — {f.numero} — {fmt(f.montant_ttc)}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setOpenEncaissement(false)}>Annuler</Button>
            <Button onClick={handleEncaissement} disabled={processing}>
              {processing?<Loader2 className="h-4 w-4 mr-2 animate-spin"/>:<CheckCircle className="h-4 w-4 mr-2"/>}Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Modal compte (code original) */}
      <Dialog open={openCompte} onOpenChange={setOpenCompte}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nouveau compte bancaire</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2"><Label>Banque</Label><Input value={formCompte.banque} onChange={e=>setFormCompte({...formCompte,banque:e.target.value})} placeholder="Attijariwafa, CIH, BMCE…"/></div>
            <div className="space-y-2"><Label>Intitulé</Label><Input value={formCompte.intitule} onChange={e=>setFormCompte({...formCompte,intitule:e.target.value})}/></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>RIB</Label><Input value={formCompte.rib} onChange={e=>setFormCompte({...formCompte,rib:e.target.value})}/></div>
              <div className="space-y-2"><Label>Solde initial (MAD)</Label><Input type="number" value={formCompte.solde_actuel} onChange={e=>setFormCompte({...formCompte,solde_actuel:parseFloat(e.target.value)||0})}/></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setOpenCompte(false)}>Annuler</Button>
            <Button onClick={async()=>{
              const{error}=await (supabase.from("comptes_bancaires") as any).insert({dossier_id:dossierId,...formCompte,iban:formCompte.iban||null});
              if(error) return toast.error(error.message);
              toast.success("Compte créé");setOpenCompte(false);
              setFormCompte({banque:"",intitule:"",rib:"",iban:"",solde_actuel:0});load();
            }}>Créer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
