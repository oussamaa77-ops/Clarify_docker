import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { ocrFacture } from "@/server/factures.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Landmark, Upload, Loader2, TrendingUp, TrendingDown, CheckCircle, FileText, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/dossiers/$dossierId/banque")({
  component: BanquePage,
});

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

// ─── Types ────────────────────────────────────────────────────────────────────
interface Compte { id: string; banque: string | null; intitule: string | null; rib: string | null; solde_actuel: number; }
interface Transaction { id: string; date_operation: string; libelle: string | null; type: string; montant: number; solde_apres: number | null; rapproche: boolean; }
interface Releve { id: string; fichier_nom: string | null; statut: string; date_debut: string | null; date_fin: string | null; nombre_transactions: number; solde_initial: number; solde_final: number; created_at: string; }
interface FactureNonPayee { id: string; type: "client" | "fournisseur"; numero: string | null; nom: string; montant_ttc: number; date_echeance: string | null; }

function BanquePage() {
  const { dossierId } = Route.useParams();
  const ocrFn = useServerFn(ocrFacture);

  const [tab, setTab] = useState<"comptes" | "releves" | "encaissements">("comptes");
  const [comptes, setComptes] = useState<Compte[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [releves, setReleves] = useState<Releve[]>([]);
  const [facturesNonPayees, setFacturesNonPayees] = useState<FactureNonPayee[]>([]);

  // Modals
  const [openCompte, setOpenCompte] = useState(false);
  const [openReleve, setOpenReleve] = useState(false);
  const [openEncaissement, setOpenEncaissement] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Formulaire compte
  const [formCompte, setFormCompte] = useState({ banque: "", intitule: "", rib: "", iban: "", solde_actuel: 0 });

  // Formulaire encaissement
  const [formEnc, setFormEnc] = useState({
    type: "especes" as "especes" | "cheque",
    montant: 0,
    date_encaissement: new Date().toISOString().slice(0, 10),
    reference: "",
    numero_cheque: "",
    banque_cheque: "",
    libelle: "",
    facture_id: "",
    facture_fournisseur_id: "",
  });

  // Transactions OCR extraites du relevé
  const [extractedTx, setExtractedTx] = useState<any[]>([]);
  const [releveCompteId, setReleveCompteId] = useState("");

  const load = async () => {
    const [{ data: c }, { data: r }, { data: fc }, { data: ff }] = await Promise.all([
      supabase.from("comptes_bancaires").select("*").eq("dossier_id", dossierId).order("created_at"),
      (supabase as any).from("releves_bancaires").select("*").eq("dossier_id", dossierId).order("created_at", { ascending: false }),
      supabase.from("factures").select("id,numero,montant_ttc,date_echeance,clients(nom)").eq("dossier_id", dossierId).eq("statut", "conforme").neq("statut_paiement", "payee"),
      supabase.from("factures_fournisseurs").select("id,numero,montant_ttc,date_echeance,fournisseur_nom").eq("dossier_id", dossierId).neq("statut_paiement", "payee"),
    ]);
    setComptes((c ?? []) as Compte[]);
    setReleves((r ?? []) as Releve[]);
    const nonPayees: FactureNonPayee[] = [
      ...((fc ?? []) as any[]).map(f => ({ id: f.id, type: "client" as const, numero: f.numero, nom: (f.clients as any)?.nom ?? "Client", montant_ttc: Number(f.montant_ttc), date_echeance: f.date_echeance })),
      ...((ff ?? []) as any[]).map(f => ({ id: f.id, type: "fournisseur" as const, numero: f.numero, nom: f.fournisseur_nom ?? "Fournisseur", montant_ttc: Number(f.montant_ttc), date_echeance: f.date_echeance })),
    ];
    setFacturesNonPayees(nonPayees);
  };

  const loadTx = async (cid: string) => {
    const { data } = await supabase.from("transactions_bancaires").select("*").eq("compte_id", cid).order("date_operation", { ascending: false }).limit(100);
    setTransactions((data ?? []) as Transaction[]);
  };

  useEffect(() => { load(); }, [dossierId]);
  useEffect(() => { if (selectedId) loadTx(selectedId); }, [selectedId]);

  const selected = comptes.find(c => c.id === selectedId);

  // ── OCR Relevé bancaire ────────────────────────────────────────────────────
  const handleReleveUpload = async (file: File) => {
    if (!releveCompteId) { toast.error("Sélectionnez d'abord un compte bancaire"); return; }
    setOcrLoading(true);
    try {
      let extractedText = "";
      const isPdf = file.type === "application/pdf" || file.name.endsWith(".pdf");
      const isExcel = file.name.endsWith(".xlsx") || file.name.endsWith(".xls");

      if (isPdf) {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
        const ab = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          extractedText += content.items.map((x: any) => x.str).join(" ") + "\n";
        }
      } else if (isExcel) {
        const XLSX = await import("xlsx");
        const ab = await file.arrayBuffer();
        const wb = XLSX.read(ab, { type: "array" });
        for (const sn of wb.SheetNames) {
          extractedText += XLSX.utils.sheet_to_csv(wb.Sheets[sn], { blankrows: false }) + "\n";
        }
      } else {
        extractedText = await file.text();
      }

      // Envoyer à Groq pour extraction structurée
      const groqKey = (window as any).__GROQ_KEY__;
      // On utilise directement le server function OCR avec un prompt spécial pour relevé
      const parsed = parseReleveText(extractedText);
      setExtractedTx(parsed);
      toast.success(`${parsed.length} transaction(s) extraite(s) — vérifiez et validez`);
    } catch (e: any) {
      toast.error("Erreur OCR relevé: " + e.message);
    } finally {
      setOcrLoading(false);
    }
  };

  // Parser relevé bancaire (regex universel multi-banques)
  const parseReleveText = (text: string): any[] => {
    const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 5);
    const transactions: any[] = [];

    // Pattern universel : date + libellé + montant
    const datePatterns = [
      /(\d{2}[\/\-]\d{2}[\/\-]\d{2,4})/,
      /(\d{4}[\/\-]\d{2}[\/\-]\d{2})/,
    ];
    const amountPattern = /(\d[\d\s]*[,.]?\d{0,2})\s*(?:MAD|DH)?/g;

    for (const line of lines) {
      let dateMatch = null;
      for (const dp of datePatterns) {
        dateMatch = line.match(dp);
        if (dateMatch) break;
      }
      if (!dateMatch) continue;

      const amounts = [...line.matchAll(amountPattern)]
        .map(m => parseFloat(m[1].replace(/\s/g, "").replace(",", ".")))
        .filter(n => !isNaN(n) && n > 0 && n < 10_000_000);

      if (!amounts.length) continue;

      const montant = amounts[amounts.length - 1];
      const libelle = line.replace(datePatterns[0], "").replace(/\d[\d\s,.]*/g, "").trim().slice(0, 100);

      // Détecter type (débit/crédit) via mots-clés
      const lineUpper = line.toUpperCase();
      const isCredit = lineUpper.includes("CREDIT") || lineUpper.includes("VIREMENT RECU") ||
        lineUpper.includes("REMISE") || lineUpper.includes("ENCAISSEMENT");
      const isDebit = lineUpper.includes("DEBIT") || lineUpper.includes("PRELEVEMENT") ||
        lineUpper.includes("PAIEMENT") || lineUpper.includes("CHEQUE") ||
        lineUpper.includes("CNSS") || lineUpper.includes("TVA") || lineUpper.includes("SALAIRE");

      // Catégoriser
      let categorie = "autre";
      if (lineUpper.includes("SALAIRE") || lineUpper.includes("PAIE")) categorie = "salaires";
      else if (lineUpper.includes("CNSS") || lineUpper.includes("AMO")) categorie = "cotisations_sociales";
      else if (lineUpper.includes("TVA") || lineUpper.includes("DGI") || lineUpper.includes("IMPOT")) categorie = "impots_taxes";
      else if (lineUpper.includes("LOYER") || lineUpper.includes("LOCATION")) categorie = "loyers";
      else if (lineUpper.includes("VIREMENT") || lineUpper.includes("FACTURE")) categorie = "paiement_facture";
      else if (isCredit) categorie = "encaissement";
      else if (isDebit) categorie = "depense";

      // Date parsing
      let date = dateMatch[1];
      const parts = date.split(/[\/\-]/);
      if (parts[0].length === 4) date = date.replace(/\//g, "-");
      else if (parts.length === 3) {
        const [dd, mm, yyyy] = parts;
        date = `${yyyy.length === 2 ? "20" + yyyy : yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
      }

      transactions.push({
        date_operation: date,
        libelle: libelle || "Transaction",
        type: isCredit ? "credit" : "debit",
        montant,
        categorie,
        compte_comptable: mapCategorieToCompte(categorie, isCredit),
        rapproche: false,
      });
    }

    return transactions.filter(t => t.montant > 0).slice(0, 200);
  };

  const mapCategorieToCompte = (cat: string, isCredit: boolean): string => {
    const map: Record<string, string> = {
      salaires: "6171",
      cotisations_sociales: "6174",
      impots_taxes: "4456",
      loyers: "6131",
      paiement_facture: isCredit ? "3421" : "4411",
      encaissement: "3421",
      depense: "6141",
      autre: isCredit ? "7111" : "6141",
    };
    return map[cat] ?? "5141";
  };

  // ── Valider le relevé et créer les écritures ──────────────────────────────
  const handleValiderReleve = async () => {
    if (!extractedTx.length || !releveCompteId) return;
    setProcessing(true);
    try {
      const compte = comptes.find(c => c.id === releveCompteId);
      let solde = compte?.solde_actuel ?? 0;

      // Créer les transactions bancaires
      const txToInsert = extractedTx.map(tx => ({
        compte_id: releveCompteId,
        dossier_id: dossierId,
        date_operation: tx.date_operation,
        libelle: tx.libelle,
        type: tx.type,
        montant: tx.montant,
        solde_apres: 0, // calculé après
        rapproche: false,
      }));

      // Calculer soldes progressifs
      let soldeCourant = solde;
      for (const tx of txToInsert) {
        if (tx.type === "credit") soldeCourant += tx.montant;
        else soldeCourant -= tx.montant;
        tx.solde_apres = Math.round(soldeCourant * 100) / 100;
      }

      await supabase.from("transactions_bancaires").insert(txToInsert);

      // Mettre à jour le solde du compte
      await supabase.from("comptes_bancaires").update({ solde_actuel: soldeCourant }).eq("id", releveCompteId);

      // Créer les écritures comptables depuis le relevé
      const ecritures: any[] = [];
      for (const tx of extractedTx) {
        const ref = tx.libelle.slice(0, 50);
        // Écriture banque
        ecritures.push({
          dossier_id: dossierId, journal_code: "BQ",
          compte_numero: "5141",
          date_ecriture: tx.date_operation,
          libelle: tx.libelle,
          debit: tx.type === "credit" ? tx.montant : 0,
          credit: tx.type === "debit" ? tx.montant : 0,
          reference_piece: ref, valide: true,
        });
        // Contre-écriture sur compte de charge/produit
        if (tx.compte_comptable && tx.compte_comptable !== "5141") {
          ecritures.push({
            dossier_id: dossierId, journal_code: "BQ",
            compte_numero: tx.compte_comptable,
            date_ecriture: tx.date_operation,
            libelle: tx.libelle,
            debit: tx.type === "debit" ? tx.montant : 0,
            credit: tx.type === "credit" ? tx.montant : 0,
            reference_piece: ref, valide: true,
          });
        }
      }
      await supabase.from("ecritures_comptables").insert(ecritures);

      // Enregistrer le relevé
      await (supabase as any).from("releves_bancaires").insert({
        compte_id: releveCompteId,
        dossier_id: dossierId,
        nombre_transactions: extractedTx.length,
        solde_initial: solde,
        solde_final: soldeCourant,
        statut: "valide",
        fichier_nom: "relevé importé",
      } as any);

      // Rapprochement automatique : chercher factures correspondantes
      await rapprochementAuto(extractedTx);

      toast.success(`${extractedTx.length} transactions importées + écritures comptables créées`);
      setExtractedTx([]);
      setOpenReleve(false);
      load();
      if (selectedId) loadTx(selectedId);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setProcessing(false);
    }
  };

  // ── Rapprochement automatique factures/relevé ─────────────────────────────
  const rapprochementAuto = async (txList: any[]) => {
    for (const tx of txList) {
      if (tx.type === "credit") {
        // Chercher facture client dont le montant correspond
        const facture = facturesNonPayees.find(f =>
          f.type === "client" && Math.abs(f.montant_ttc - tx.montant) < 0.01
        );
        if (facture) {
          await supabase.from("factures").update({ statut_paiement: "payee", date_paiement: tx.date_operation }).eq("id", facture.id);
          // Remplacer créance client par encaissement banque
          await supabase.from("ecritures_comptables").insert([
            { dossier_id: dossierId, journal_code: "BQ", compte_numero: "3421", date_ecriture: tx.date_operation, libelle: `Règlement ${facture.nom} ${facture.numero ?? ""}`, debit: 0, credit: tx.montant, reference_piece: facture.numero ?? "", valide: true },
          ]);
          console.log("[Rapprochement] Facture client payée automatiquement:", facture.numero);
        }
      } else {
        // Chercher facture fournisseur
        const facture = facturesNonPayees.find(f =>
          f.type === "fournisseur" && Math.abs(f.montant_ttc - tx.montant) < 0.01
        );
        if (facture) {
          await supabase.from("factures_fournisseurs").update({ statut_paiement: "payee", date_paiement: tx.date_operation } as any).eq("id", facture.id);
          await supabase.from("ecritures_comptables").insert([
            { dossier_id: dossierId, journal_code: "BQ", compte_numero: "4411", date_ecriture: tx.date_operation, libelle: `Paiement ${facture.nom}`, debit: tx.montant, credit: 0, reference_piece: facture.numero ?? "", valide: true },
          ]);
          console.log("[Rapprochement] Facture fournisseur payée automatiquement:", facture.numero);
        }
      }
    }
  };

  // ── Enregistrer encaissement espèces/chèque ───────────────────────────────
  const handleEncaissement = async () => {
    if (!formEnc.montant || !formEnc.date_encaissement) return toast.error("Montant et date requis");
    setProcessing(true);
    try {
      const { error } = await supabase.from("encaissements" as any).insert({
        dossier_id: dossierId,
        type: formEnc.type,
        montant: formEnc.montant,
        date_encaissement: formEnc.date_encaissement,
        reference: formEnc.reference || null,
        numero_cheque: formEnc.numero_cheque || null,
        banque_cheque: formEnc.banque_cheque || null,
        libelle: formEnc.libelle || null,
        facture_id: formEnc.facture_id || null,
        facture_fournisseur_id: formEnc.facture_fournisseur_id || null,
        valide: true,
      });
      if (error) throw error;

      const journalCode = formEnc.type === "especes" ? "CAI" : "BQ";
      const compteDebit = formEnc.type === "especes" ? "5161" : "5141";

      // Écriture comptable encaissement
      await supabase.from("ecritures_comptables").insert([
        { dossier_id: dossierId, journal_code: journalCode, compte_numero: compteDebit, date_ecriture: formEnc.date_encaissement, libelle: formEnc.libelle || `Encaissement ${formEnc.type}`, debit: formEnc.montant, credit: 0, reference_piece: formEnc.reference || null, valide: true },
        { dossier_id: dossierId, journal_code: journalCode, compte_numero: formEnc.facture_id ? "3421" : formEnc.facture_fournisseur_id ? "4411" : "7111", date_ecriture: formEnc.date_encaissement, libelle: formEnc.libelle || `Règlement`, debit: 0, credit: formEnc.montant, reference_piece: formEnc.reference || null, valide: true },
      ]);

      // Marquer facture payée si liée
      if (formEnc.facture_id) {
        await supabase.from("factures").update({ statut_paiement: "payee", date_paiement: formEnc.date_encaissement }).eq("id", formEnc.facture_id);
      }
      if (formEnc.facture_fournisseur_id) {
        await supabase.from("factures_fournisseurs").update({ statut_paiement: "payee", date_paiement: formEnc.date_encaissement } as any).eq("id", formEnc.facture_fournisseur_id);
      }

      toast.success("Encaissement enregistré + écriture comptable créée");
      setOpenEncaissement(false);
      setFormEnc({ type: "especes", montant: 0, date_encaissement: new Date().toISOString().slice(0, 10), reference: "", numero_cheque: "", banque_cheque: "", libelle: "", facture_id: "", facture_fournisseur_id: "" });
      load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Banque & Trésorerie</h1>
          <p className="text-muted-foreground mt-1">Relevés bancaires · Rapprochement auto · Encaissements espèces/chèques</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setOpenEncaissement(true)}>
            <FileText className="h-4 w-4 mr-2" />Encaissement espèces/chèque
          </Button>
          <Button onClick={() => setOpenCompte(true)}>
            <Plus className="h-4 w-4 mr-2" />Compte bancaire
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="comptes">Comptes ({comptes.length})</TabsTrigger>
          <TabsTrigger value="releves">
            Relevés bancaires
            {facturesNonPayees.length > 0 && <span className="ml-2 bg-orange-500 text-white text-xs px-1.5 py-0.5 rounded-full">{facturesNonPayees.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="encaissements">Encaissements espèces/chèques</TabsTrigger>
        </TabsList>

        {/* ── Comptes ── */}
        <TabsContent value="comptes" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            {comptes.length === 0 ? (
              <Card className="col-span-3"><CardContent className="py-12 text-center text-muted-foreground">
                <Landmark className="h-10 w-10 mx-auto mb-2 opacity-30" />
                <p>Aucun compte bancaire — créez-en un</p>
              </CardContent></Card>
            ) : comptes.map(c => (
              <Card key={c.id} className={`cursor-pointer transition-all ${selectedId === c.id ? "ring-2 ring-primary" : "hover:shadow-md"}`}
                onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}>
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-muted-foreground">{c.banque}</span>
                    <Landmark className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <p className="font-semibold">{c.intitule}</p>
                  <p className="font-mono text-xs text-muted-foreground mt-1">{c.rib}</p>
                  <p className={`text-2xl font-bold mt-3 ${c.solde_actuel >= 0 ? "text-green-600" : "text-red-600"}`}>{fmt(c.solde_actuel)}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {selectedId && (
            <>
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold">Transactions — {selected?.intitule}</h2>
                <Button size="sm" onClick={() => { setReleveCompteId(selectedId); setOpenReleve(true); }}>
                  <Upload className="h-3 w-3 mr-1" />Importer relevé
                </Button>
              </div>
              <Card><CardContent className="p-0">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>Date</TableHead><TableHead>Libellé</TableHead><TableHead>Type</TableHead>
                    <TableHead className="text-right">Montant</TableHead><TableHead className="text-right">Solde</TableHead><TableHead>Rapproché</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {transactions.length === 0
                      ? <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Importez un relevé bancaire</TableCell></TableRow>
                      : transactions.map(t => (
                        <TableRow key={t.id}>
                          <TableCell className="text-sm">{new Date(t.date_operation).toLocaleDateString("fr-MA")}</TableCell>
                          <TableCell className="text-sm max-w-[250px] truncate">{t.libelle}</TableCell>
                          <TableCell>
                            <Badge className={t.type === "credit" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}>
                              {t.type === "credit" ? <TrendingUp className="h-3 w-3 mr-1" /> : <TrendingDown className="h-3 w-3 mr-1" />}
                              {t.type}
                            </Badge>
                          </TableCell>
                          <TableCell className={`text-right font-mono text-sm ${t.type === "credit" ? "text-green-600" : "text-red-600"}`}>
                            {t.type === "credit" ? "+" : "-"}{fmt(t.montant)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">{t.solde_apres != null ? fmt(t.solde_apres) : "—"}</TableCell>
                          <TableCell>
                            {t.rapproche
                              ? <Badge className="bg-green-100 text-green-700 text-xs"><CheckCircle className="h-3 w-3 mr-1" />Oui</Badge>
                              : <Badge variant="secondary" className="text-xs">Non</Badge>}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </CardContent></Card>
            </>
          )}
        </TabsContent>

        {/* ── Relevés ── */}
        <TabsContent value="releves" className="mt-4">
          <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-950/20 rounded-lg border border-blue-200 text-sm text-blue-700 dark:text-blue-300">
            <p className="font-medium mb-1">📋 Comment ça fonctionne</p>
            <p>1. Sélectionnez un compte bancaire</p>
            <p>2. Importez le relevé PDF ou Excel de votre banque</p>
            <p>3. Vérifiez les transactions extraites</p>
            <p>4. Validez → écritures PCM créées + rapprochement automatique des factures</p>
          </div>

          {facturesNonPayees.length > 0 && (
            <Card className="mb-4 border-orange-200">
              <CardContent className="pt-4 pb-4">
                <p className="font-medium text-sm mb-3 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-orange-500" />
                  {facturesNonPayees.length} facture(s) en attente de paiement — seront rapprochées automatiquement si le montant correspond dans le relevé
                </p>
                <div className="space-y-1">
                  {facturesNonPayees.slice(0, 5).map(f => (
                    <div key={f.id} className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{f.type === "client" ? "📤" : "📥"} {f.nom} — {f.numero}</span>
                      <span className="font-mono font-semibold">{fmt(f.montant_ttc)}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Fichier</TableHead><TableHead>Compte</TableHead>
                <TableHead>Transactions</TableHead><TableHead>Solde final</TableHead><TableHead>Statut</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {releves.length === 0
                  ? <TableRow><TableCell colSpan={5} className="text-center py-10 text-muted-foreground">Aucun relevé importé</TableCell></TableRow>
                  : releves.map(r => (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm">{r.fichier_nom ?? "Relevé"}</TableCell>
                      <TableCell className="text-sm">{comptes.find(c => c.id === (r as any).compte_id)?.intitule ?? "—"}</TableCell>
                      <TableCell className="font-mono text-sm">{r.nombre_transactions}</TableCell>
                      <TableCell className="font-mono text-sm">{fmt(Number(r.solde_final))}</TableCell>
                      <TableCell>
                        <Badge variant={(r.statut as any) === "valide" ? "default" : "secondary"}>
                          {(r.statut as any) === "valide" ? "✅ Validé" : r.statut}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        {/* ── Encaissements espèces/chèques ── */}
        <TabsContent value="encaissements" className="mt-4">
          <div className="mb-4 p-4 bg-muted rounded-lg text-sm">
            <p className="font-medium mb-1">Encaissements hors virement bancaire</p>
            <p className="text-muted-foreground">Pour les paiements reçus en espèces ou par chèque, saisissez l'encaissement ici. Il sera enregistré dans le journal de caisse (5161) ou banque (5141) et la facture correspondante sera marquée payée.</p>
          </div>
          <Button onClick={() => setOpenEncaissement(true)}>
            <Plus className="h-4 w-4 mr-2" />Saisir un encaissement
          </Button>
        </TabsContent>
      </Tabs>

      {/* ── Modal import relevé ── */}
      <Dialog open={openReleve} onOpenChange={v => { setOpenReleve(v); if (!v) setExtractedTx([]); }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Importer un relevé bancaire</DialogTitle></DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Compte bancaire *</Label>
              <Select value={releveCompteId} onValueChange={setReleveCompteId}>
                <SelectTrigger><SelectValue placeholder="Sélectionner le compte…" /></SelectTrigger>
                <SelectContent>{comptes.map(c => <SelectItem key={c.id} value={c.id}>{c.intitule} — {c.banque}</SelectItem>)}</SelectContent>
              </Select>
            </div>

            <div
              className="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer hover:border-primary transition-colors"
              onClick={() => fileRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleReleveUpload(f); }}>
              <input ref={fileRef} type="file" className="hidden" accept=".pdf,.xlsx,.xls,.txt,.csv"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleReleveUpload(f); }} />
              {ocrLoading
                ? <><Loader2 className="h-8 w-8 animate-spin mx-auto text-primary mb-2" /><p>Extraction en cours…</p></>
                : <><Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" /><p className="font-medium">Glissez votre relevé bancaire</p><p className="text-xs text-muted-foreground mt-1">PDF · Excel · CSV — Compatible toutes banques marocaines</p></>
              }
            </div>

            {extractedTx.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="font-medium">{extractedTx.length} transaction(s) extraite(s)</p>
                  <div className="flex gap-2 text-xs text-muted-foreground">
                    <span className="text-green-600">+{extractedTx.filter(t => t.type === "credit").length} crédits</span>
                    <span className="text-red-600">-{extractedTx.filter(t => t.type === "debit").length} débits</span>
                  </div>
                </div>
                <div className="rounded border overflow-hidden max-h-72 overflow-y-auto">
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Date</TableHead><TableHead>Libellé</TableHead><TableHead>Type</TableHead>
                      <TableHead>Montant</TableHead><TableHead>Catégorie</TableHead><TableHead>Compte PCM</TableHead>
                    </TableRow></TableHeader>
                    <TableBody>
                      {extractedTx.map((t, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{t.date_operation}</TableCell>
                          <TableCell className="text-xs max-w-[150px] truncate">{t.libelle}</TableCell>
                          <TableCell>
                            <Badge className={t.type === "credit" ? "bg-green-100 text-green-700 text-xs" : "bg-red-100 text-red-700 text-xs"}>
                              {t.type}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{fmt(t.montant)}</TableCell>
                          <TableCell className="text-xs">{t.categorie}</TableCell>
                          <TableCell className="font-mono text-xs">{t.compte_comptable}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setOpenReleve(false); setExtractedTx([]); }}>Annuler</Button>
            <Button onClick={handleValiderReleve} disabled={!extractedTx.length || processing}>
              {processing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-2" />}
              Valider et enregistrer ({extractedTx.length} transactions)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Modal encaissement espèces/chèque ── */}
      <Dialog open={openEncaissement} onOpenChange={setOpenEncaissement}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Encaissement espèces / chèque</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Type *</Label>
              <Select value={formEnc.type} onValueChange={v => setFormEnc({ ...formEnc, type: v as any })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="especes">💵 Espèces</SelectItem>
                  <SelectItem value="cheque">🏦 Chèque</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>Montant (MAD) *</Label><Input type="number" step="0.01" value={formEnc.montant} onChange={e => setFormEnc({ ...formEnc, montant: parseFloat(e.target.value) || 0 })} /></div>
              <div className="space-y-2"><Label>Date *</Label><Input type="date" value={formEnc.date_encaissement} onChange={e => setFormEnc({ ...formEnc, date_encaissement: e.target.value })} /></div>
            </div>

            {formEnc.type === "cheque" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2"><Label>N° chèque</Label><Input value={formEnc.numero_cheque} onChange={e => setFormEnc({ ...formEnc, numero_cheque: e.target.value })} /></div>
                <div className="space-y-2"><Label>Banque</Label><Input value={formEnc.banque_cheque} onChange={e => setFormEnc({ ...formEnc, banque_cheque: e.target.value })} /></div>
              </div>
            )}

            <div className="space-y-2"><Label>Libellé</Label><Input value={formEnc.libelle} onChange={e => setFormEnc({ ...formEnc, libelle: e.target.value })} placeholder="Paiement facture F2026-001…" /></div>

            <div className="space-y-2">
              <Label>Facture concernée (optionnel)</Label>
              <Select value={formEnc.facture_id || formEnc.facture_fournisseur_id || ""} onValueChange={v => {
  if (v === "none") {
    setFormEnc({ ...formEnc, facture_id: "", facture_fournisseur_id: "" });
    return;
  }
  const f = facturesNonPayees.find(f => f.id === v);
  if (f?.type === "client") setFormEnc({ ...formEnc, facture_id: v, facture_fournisseur_id: "", montant: f.montant_ttc });
  else if (f?.type === "fournisseur") setFormEnc({ ...formEnc, facture_fournisseur_id: v, facture_id: "", montant: f.montant_ttc });
}}>
                <SelectTrigger><SelectValue placeholder="Aucune facture liée" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Aucune facture liée</SelectItem>
                  {facturesNonPayees.map(f => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.type === "client" ? "📤" : "📥"} {f.nom} — {f.numero} — {fmt(f.montant_ttc)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenEncaissement(false)}>Annuler</Button>
            <Button onClick={handleEncaissement} disabled={processing}>
              {processing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-2" />}
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Modal nouveau compte ── */}
      <Dialog open={openCompte} onOpenChange={setOpenCompte}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nouveau compte bancaire</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2"><Label>Banque</Label><Input value={formCompte.banque} onChange={e => setFormCompte({ ...formCompte, banque: e.target.value })} placeholder="Attijariwafa, CIH, BMCE…" /></div>
            <div className="space-y-2"><Label>Intitulé</Label><Input value={formCompte.intitule} onChange={e => setFormCompte({ ...formCompte, intitule: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>RIB</Label><Input value={formCompte.rib} onChange={e => setFormCompte({ ...formCompte, rib: e.target.value })} /></div>
              <div className="space-y-2"><Label>Solde initial (MAD)</Label><Input type="number" value={formCompte.solde_actuel} onChange={e => setFormCompte({ ...formCompte, solde_actuel: parseFloat(e.target.value) || 0 })} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenCompte(false)}>Annuler</Button>
            <Button onClick={async () => {
              const { error } = await supabase.from("comptes_bancaires").insert({ dossier_id: dossierId, ...formCompte, iban: formCompte.iban || null });
              if (error) return toast.error(error.message);
              toast.success("Compte créé");
              setOpenCompte(false);
              setFormCompte({ banque: "", intitule: "", rib: "", iban: "", solde_actuel: 0 });
              load();
            }}>Créer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
