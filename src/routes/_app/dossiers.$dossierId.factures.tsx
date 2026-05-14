
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { generateFactureXml, marquerPayee, ocrFacture, ajouterEmailClient } from "@/server/factures.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, FileCode, Eye, CheckCircle, Upload, Loader2, Download, X, AlertCircle, CheckCircle2, UserPlus, Clock, Mail, FileText } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/dossiers/$dossierId/factures")({ component: FacturesPage });

interface Ligne { designation: string; quantite: number; prix_unitaire: number; taux_tva: number }
interface Client { id: string; nom: string; ice: string | null; email: string | null }
interface Facture {
  id: string; numero: string | null; date_facture: string; date_echeance: string | null;
  client_id: string | null; statut: string; statut_paiement: string; statut_dgi: string | null;
  montant_ht: number; montant_ttc: number; montant_tva: number;
  xml_ubl: string | null; hash_sha256: string | null; dgi_uuid: string | null; dgi_response: any;
  fichier_original_url: string | null; fichier_original_nom: string | null; fichier_original_type: string | null;
}
// CORRECTION 1 : Interface OcrData avec nouveaux champs acompte
interface OcrData {
  client_nom_extrait: string; ice_client: string | null; if_fiscal_client: string | null;
  rc_client: string | null; numero_facture: string | null; date_facture: string | null;
  date_echeance: string | null; delai_paiement_jours: number | null; mode_reglement: string | null;
  montant_ht: number; montant_tva: number; montant_ttc: number;
  // Nouveaux champs acompte
  type_facture: string;
  numero_commande: string | null;
  numero_acompte: number | null;
  montant_commande_total_ht: number | null;
  montant_commande_total_ttc: number | null;
  montant_restant_du: number | null;
  lignes: Ligne[]; confidence: string; method: string;
  client_id: string | null; client_action: "found" | "created" | "not_found"; client_trouve: any;
}

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

function DGIBadge({ statut, statut_dgi }: { statut: string; statut_dgi: string | null }) {
  if (statut_dgi === "en_analyse" || statut === "envoyee") {
    return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300 flex items-center gap-1"><Clock className="h-3 w-3" />En analyse DGI</Badge>;
  }
  if (statut === "conforme" || statut_dgi === "conforme") {
    return <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">✅ Conforme</Badge>;
  }
  if (statut === "rejetee" || statut_dgi === "rejetee") {
    return <Badge variant="destructive">❌ Rejeté</Badge>;
  }
  return <Badge variant="secondary">{statut}</Badge>;
}

function FacturesPage() {
  const { dossierId } = Route.useParams();
  const genXml = useServerFn(generateFactureXml);
  const payFn = useServerFn(marquerPayee);
  const ocrFn = useServerFn(ocrFacture);
  const addEmailFn = useServerFn(ajouterEmailClient);

  const [factures, setFactures] = useState<Facture[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [openCreate, setOpenCreate] = useState(false);
  const [viewXml, setViewXml] = useState<Facture | null>(null);
  const [dgiResult, setDgiResult] = useState<any>(null);
  const [processing, setProcessing] = useState<string | null>(null);

  const [emailModal, setEmailModal] = useState<{ clientId: string; factureId: string } | null>(null);
  const [emailInput, setEmailInput] = useState("");

  const [clientId, setClientId] = useState("");
  const [numero, setNumero] = useState("");
  const [dateF, setDateF] = useState(new Date().toISOString().slice(0, 10));
  const [dateE, setDateE] = useState("");
  const [lignes, setLignes] = useState<Ligne[]>([{ designation: "", quantite: 1, prix_unitaire: 0, taux_tva: 20 }]);

  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrData, setOcrData] = useState<OcrData | null>(null);
  const [activeTab, setActiveTab] = useState("ocr");
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    const [{ data: f }, { data: c }] = await Promise.all([
      supabase.from("factures").select("*").eq("dossier_id", dossierId).order("date_facture", { ascending: false }),
      supabase.from("clients").select("id,nom,ice,email").eq("dossier_id", dossierId).is("deleted_at", null).order("nom"),
    ]);
    setFactures((f ?? []) as unknown as Facture[]);
    setClients((c ?? []) as Client[]);
    setLoading(false);
  };
  useEffect(() => { load(); }, [dossierId]);

  const ht = lignes.reduce((s, l) => s + l.quantite * l.prix_unitaire, 0);
  const tva = lignes.reduce((s, l) => s + l.quantite * l.prix_unitaire * l.taux_tva / 100, 0);
  const ttc = ht + tva;
  const setLigne = (i: number, f: keyof Ligne, v: any) =>
    setLignes(ls => ls.map((l, j) => j === i ? { ...l, [f]: v } : l));

  const handleOcr = async (file: File) => {
    setOcrLoading(true);
    setOcrData(null);
    setOriginalFile(file);
    try {
      let extractedText = "";
      let image_base64: string | undefined = undefined;
      const mime_type = file.type || "application/octet-stream";
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      const isExcel = file.name.toLowerCase().endsWith(".xlsx") || file.name.toLowerCase().endsWith(".xls");
      const isImage = file.type.startsWith("image/");

      if (isPdf) {
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          fullText += content.items.map((item: any) => item.str).join(" ") + "\\n";
        }
        extractedText = fullText.trim();
      } else if (isExcel) {
        const XLSX = await import("xlsx");
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: "array" });
        let allText = "";
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          allText += `[Feuille: ${sheetName}]\\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}\\n\\n`;
        }
        extractedText = allText.trim();
      } else if (isImage) {
        image_base64 = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => {
            const full = r.result as string;
            const base64 = full.includes(",") ? full.split(",")[1] : full;
            if (base64.length > 4_000_000) { rej(new Error("Image trop grande — max 3MB")); return; }
            res(base64);
          };
          r.onerror = rej;
          r.readAsDataURL(file);
        });
      } else {
        extractedText = await file.text();
      }

      const result = await ocrFn({ data: { extracted_text: extractedText, image_base64, mime_type, dossier_id: dossierId } });
      const r = result.result as OcrData;
      setOcrData(r);

      // CORRECTION 2 : Vérifier que le client détecté n'est pas la propre société du dossier
      if (r.client_id && r.client_action !== "not_found") {
        const { data: dossierData } = await supabase.from("dossiers").select("nom_societe").eq("id", dossierId).single();
        const nomSociete = (dossierData?.nom_societe ?? "").toLowerCase();
        const nomClient  = (r.client_nom_extrait ?? "").toLowerCase();
        // Si le nom détecté ressemble au nom de la société → c'est l'émetteur, pas le client
        const estEmetteur = nomSociete.length > 3 && nomClient.includes(nomSociete.slice(0, 6));
        if (!estEmetteur) {
          setClientId(r.client_id);
        } else {
          toast.warning("Le client détecté semble être votre propre société — sélectionnez le bon client manuellement");
        }
      }

      if (r.numero_facture) setNumero(r.numero_facture);
      if (r.date_facture) setDateF(r.date_facture);
      if (r.date_echeance) setDateE(r.date_echeance);
      if (r.lignes?.length) setLignes(r.lignes);
      if (r.client_action === "created") { await load(); toast.success(`Client "${r.client_nom_extrait}" créé automatiquement`); }
      else if (r.client_action === "found") toast.success(`Client "${r.client_trouve?.nom}" identifié`);
      else toast.warning("Client non identifié — sélectionnez manuellement");
      setActiveTab("formulaire");
    } catch (e: any) { toast.error("Erreur OCR: " + e.message); }
    finally { setOcrLoading(false); }
  };

  const handleCreate = async () => {
    if (!clientId) return toast.error("Sélectionnez un client");
    if (!lignes[0].designation) return toast.error("Ajoutez au moins une ligne");
    const { data: authData } = await supabase.auth.getUser();
    const { data: newFact, error } = await supabase.from("factures").insert({
      dossier_id: dossierId, client_id: clientId, numero: numero || null,
      date_facture: dateF, date_echeance: dateE || null,
      lignes: lignes as any, montant_ht: ht, montant_tva: tva, montant_ttc: ttc,
      statut: "brouillon", statut_paiement: "non_payee", created_by: authData?.user?.id ?? null,
    }).select().single();
    if (error) return toast.error(error.message);

    if (originalFile && newFact) {
      const ext = originalFile.name.split(".").pop();
      const path = `${dossierId}/${newFact.id}.${ext}`;
      const { data: uploadData } = await supabase.storage.from("factures-originales").upload(path, originalFile, { upsert: true });
      if (uploadData) {
        const { data: urlData } = supabase.storage.from("factures-originales").getPublicUrl(path);
        await (supabase.from("factures") as any).update({
          fichier_original_url: urlData?.publicUrl ?? null,
          fichier_original_nom: originalFile.name,
          fichier_original_type: originalFile.type,
        }).eq("id", newFact.id);
      }
    }

    toast.success("Facture créée");
    setOpenCreate(false);
    setOcrData(null); setOriginalFile(null); setActiveTab("ocr");
    setLignes([{ designation: "", quantite: 1, prix_unitaire: 0, taux_tva: 20 }]);
    setClientId(""); setNumero(""); setDateE("");
    load();
  };

  const handleGenXml = async (f: Facture) => {
    const client = clients.find(c => c.id === f.client_id);
    if (!client?.email) {
      setEmailModal({ clientId: f.client_id!, factureId: f.id });
      toast.warning("Email client manquant — ajoutez-le pour envoyer la facture");
      return;
    }
    setProcessing(f.id);
    try {
      const res = await genXml({ data: { facture_id: f.id } });
      setDgiResult(res);
      if (res.conforme) toast.success("✅ Facture conforme DGI — email envoyé au client");
      else toast.error("❌ Facture rejetée par la DGI");
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setProcessing(null); }
  };

  const handleGenXmlSansEmail = async (fid: string) => {
    setProcessing(fid);
    setEmailModal(null);
    try {
      const res = await genXml({ data: { facture_id: fid } });
      setDgiResult(res);
      if (res.conforme) toast.success("✅ Facture conforme DGI (sans email client)");
      else toast.error("❌ Facture rejetée");
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setProcessing(null); }
  };

  const handleAddEmail = async () => {
    if (!emailModal || !emailInput) return;
    try {
      await addEmailFn({ data: { client_id: emailModal.clientId, email: emailInput } });
      toast.success("Email ajouté");
      await load();
      const f = factures.find(f => f.id === emailModal.factureId);
      if (f) { setEmailModal(null); setEmailInput(""); handleGenXmlSansEmail(f.id); }
    } catch (e: any) { toast.error(e.message); }
  };

  const handlePay = async (fid: string) => {
    setProcessing(fid);
    try {
      await payFn({ data: { facture_id: fid, date_paiement: new Date().toISOString().slice(0, 10) } });
      toast.success("Facture payée + écriture banque créée");
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setProcessing(null); }
  };

  const viewOriginal = (f: Facture) => {
    if (f.fichier_original_url) window.open(f.fichier_original_url, "_blank");
  };

  const conformes = factures.filter(f => f.statut === "conforme");
  const caHT = conformes.reduce((s, f) => s + Number(f.montant_ht), 0);
  const encours = conformes.filter(f => f.statut_paiement !== "payee").reduce((s, f) => s + Number(f.montant_ttc), 0);
  const enAnalyse = factures.filter(f => f.statut === "envoyee" || f.statut_dgi === "en_analyse").length;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Factures clients</h1>
          <p className="text-muted-foreground mt-1">E-facture DGI · XML UBL 2.1 · SHA-256</p>
        </div>
        <Dialog open={openCreate} onOpenChange={v => { setOpenCreate(v); if (!v) { setOcrData(null); setOriginalFile(null); setActiveTab("ocr"); } }}>
          <DialogTrigger asChild><Button><Plus className="h-4 w-4 mr-2" />Nouvelle facture</Button></DialogTrigger>
          <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
            <DialogHeader><DialogTitle>Créer une facture</DialogTitle></DialogHeader>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsList>
                <TabsTrigger value="ocr">📄 Scan OCR</TabsTrigger>
                <TabsTrigger value="formulaire">✏️ Formulaire {ocrData && <span className="ml-1 text-xs bg-green-500 text-white px-1 rounded">auto</span>}</TabsTrigger>
              </TabsList>

              <TabsContent value="ocr" className="space-y-4 mt-4">
                <div className="border-2 border-dashed rounded-xl p-10 text-center cursor-pointer hover:border-primary transition-colors"
                  onClick={() => fileRef.current?.click()}
                  onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleOcr(f); }}>
                  <input ref={fileRef} type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.txt"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleOcr(f); }} />
                  {ocrLoading
                    ? <><Loader2 className="h-10 w-10 animate-spin mx-auto text-primary mb-2" /><p className="font-medium">Extraction en cours…</p><p className="text-xs text-muted-foreground">PDF.js → Groq Llama 4 · Résolution client auto</p></>
                    : <><Upload className="h-10 w-10 mx-auto mb-2 text-muted-foreground" /><p className="font-medium">Glissez une facture ici</p><p className="text-xs text-muted-foreground mt-1">PDF · Image (JPG/PNG) · Excel — Extraction IA · Client auto</p></>
                  }
                </div>

                {ocrData && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={ocrData.confidence === "high" ? "default" : "secondary"}>Confiance : {ocrData.confidence}</Badge>
                      <Badge variant="outline">Méthode : {ocrData.method}</Badge>
                      {ocrData.client_action === "created" && <Badge className="bg-blue-100 text-blue-700"><UserPlus className="h-3 w-3 mr-1" />Client créé auto</Badge>}
                      {ocrData.client_action === "found" && <Badge className="bg-green-100 text-green-700"><CheckCircle2 className="h-3 w-3 mr-1" />Client identifié</Badge>}
                      {ocrData.client_action === "not_found" && <Badge className="bg-yellow-100 text-yellow-700"><AlertCircle className="h-3 w-3 mr-1" />Client non identifié</Badge>}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {[
                        { label: "Client détecté", val: ocrData.client_nom_extrait, required: true },
                        { label: "N° Facture", val: ocrData.numero_facture, required: false },
                        { label: "Date facture", val: ocrData.date_facture, required: true },
                        { label: "Date échéance", val: ocrData.date_echeance ?? (ocrData.delai_paiement_jours ? `${ocrData.delai_paiement_jours}j calculé` : null), required: false },
                        { label: "ICE Client", val: ocrData.ice_client, required: false },
                        { label: "Mode règlement", val: ocrData.mode_reglement, required: false },
                      ].map(({ label, val, required }) => (
                        <Card key={label} className={val ? "border-green-200 dark:border-green-800" : required ? "border-red-200 dark:border-red-800" : "border-yellow-200 dark:border-yellow-800"}>
                          <CardContent className="pt-3 pb-3">
                            <p className="text-xs text-muted-foreground mb-1">{label}</p>
                            <p className="font-semibold text-sm">{val || <span className={required ? "text-red-500" : "text-yellow-500"}>Non détecté</span>}</p>
                          </CardContent>
                        </Card>
                      ))}
                    </div>

                    {/* Montants principaux */}
                    <Card className={Number(ocrData.montant_ttc) > 0 ? "border-green-200" : "border-red-200"}>
                      <CardContent className="pt-3 pb-3 flex justify-between items-center">
                        <div>
                          <p className="text-xs text-muted-foreground">HT: {fmt(ocrData.montant_ht)} · TVA: {fmt(ocrData.montant_tva)}</p>
                          <p className="text-xl font-bold text-primary">{ocrData.montant_ttc > 0 ? fmt(ocrData.montant_ttc) : <span className="text-red-500">Non détecté</span>}</p>
                        </div>
                        <p className="text-xs text-muted-foreground">{ocrData.lignes?.length} ligne(s)</p>
                      </CardContent>
                    </Card>

                    {/* CORRECTION 3A : Badge type facture */}
                    {ocrData.type_facture && ocrData.type_facture !== "standard" && (
                      <div className="flex items-center gap-2">
                        <Badge className={
                          ocrData.type_facture === "acompte" ? "bg-blue-100 text-blue-700" :
                          ocrData.type_facture === "solde"   ? "bg-purple-100 text-purple-700" :
                          ocrData.type_facture === "avoir"   ? "bg-red-100 text-red-700" : ""
                        }>
                          {ocrData.type_facture === "acompte" ? `🔵 Acompte ${ocrData.numero_acompte ?? ""}` :
                           ocrData.type_facture === "solde"   ? "🟣 Facture de solde" :
                           ocrData.type_facture === "avoir"   ? "🔴 Avoir / Crédit" : ""}
                        </Badge>
                        {ocrData.numero_commande && (
                          <span className="text-xs text-muted-foreground">Commande : {ocrData.numero_commande}</span>
                        )}
                      </div>
                    )}

                    {/* CORRECTION 3B : Bloc acompte détaillé */}
                    {ocrData.type_facture === "acompte" && (
                      <Card className="border-blue-200 bg-blue-50/50 dark:bg-blue-950/10">
                        <CardContent className="pt-3 pb-3 space-y-2">
                          <p className="text-xs font-semibold text-blue-700">Détail de la commande</p>
                          {ocrData.montant_commande_total_ttc && (
                            <div className="flex justify-between text-xs">
                              <span className="text-muted-foreground">Total commande TTC</span>
                              <span className="font-mono">{fmt(ocrData.montant_commande_total_ttc)}</span>
                            </div>
                          )}
                          <div className="flex justify-between text-xs text-green-700">
                            <span className="font-medium">Cet acompte (facturé)</span>
                            <span className="font-mono font-semibold">{fmt(ocrData.montant_ttc)}</span>
                          </div>
                          {ocrData.montant_restant_du && (
                            <div className="flex justify-between text-xs text-orange-700 border-t border-orange-200 pt-1">
                              <span className="font-semibold">Reliquat restant dû</span>
                              <span className="font-mono font-semibold">{fmt(ocrData.montant_restant_du)}</span>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    {ocrData.lignes?.length > 0 && (
                      <div className="rounded-lg border overflow-hidden">
                        <Table>
                          <TableHeader><TableRow><TableHead>Désignation</TableHead><TableHead>Qté</TableHead><TableHead>PU HT</TableHead><TableHead>TVA</TableHead></TableRow></TableHeader>
                          <TableBody>
                            {ocrData.lignes.map((l, i) => (
                              <TableRow key={i}><TableCell className="text-sm">{l.designation}</TableCell><TableCell className="font-mono text-sm">{l.quantite}</TableCell><TableCell className="font-mono text-sm">{fmt(l.prix_unitaire)}</TableCell><TableCell className="text-sm">{l.taux_tva}%</TableCell></TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}

                    <div className="flex gap-2 pt-2 border-t">
                      <Button onClick={() => setActiveTab("formulaire")} className="flex-1"><CheckCircle className="h-4 w-4 mr-2" />Vérifier dans le formulaire</Button>
                      <Button variant="outline" onClick={() => fileRef.current?.click()}><Upload className="h-4 w-4 mr-2" />Rescanner</Button>
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="formulaire" className="mt-4 space-y-4">
                {ocrData && <div className="p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg text-xs text-blue-700 dark:text-blue-300 border border-blue-200">✅ Données pré-remplies depuis l\'OCR — vérifiez avant de créer.</div>}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Client *</Label>
                    <Select value={clientId} onValueChange={setClientId}>
                      <SelectTrigger><SelectValue placeholder="Sélectionner…" /></SelectTrigger>
                      <SelectContent>{clients.map(c => <SelectItem key={c.id} value={c.id}>{c.nom}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2"><Label>N° Facture</Label><Input value={numero} onChange={e => setNumero(e.target.value)} placeholder="F2026-001" /></div>
                  <div className="space-y-2"><Label>Date facture</Label><Input type="date" value={dateF} onChange={e => setDateF(e.target.value)} /></div>
                  <div className="space-y-2"><Label>Date échéance</Label><Input type="date" value={dateE} onChange={e => setDateE(e.target.value)} /></div>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label>Lignes</Label>
                    <Button type="button" variant="outline" size="sm" onClick={() => setLignes(ls => [...ls, { designation: "", quantite: 1, prix_unitaire: 0, taux_tva: 20 }])}><Plus className="h-3 w-3 mr-1" />Ligne</Button>
                  </div>
                  {lignes.map((l, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center mb-2">
                      <Input className="col-span-5" placeholder="Désignation" value={l.designation} onChange={e => setLigne(i, "designation", e.target.value)} />
                      <Input className="col-span-2" type="number" placeholder="Qté" value={l.quantite} onChange={e => setLigne(i, "quantite", +e.target.value)} />
                      <Input className="col-span-2" type="number" placeholder="PU HT" value={l.prix_unitaire} onChange={e => setLigne(i, "prix_unitaire", +e.target.value)} />
                      <Select value={String(l.taux_tva)} onValueChange={v => setLigne(i, "taux_tva", +v)}>
                        <SelectTrigger className="col-span-2"><SelectValue /></SelectTrigger>
                        <SelectContent>{[0, 7, 10, 14, 20].map(r => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}</SelectContent>
                      </Select>
                      <Button type="button" variant="ghost" size="icon" onClick={() => setLignes(ls => ls.filter((_, j) => j !== i))} disabled={lignes.length === 1}><X className="h-4 w-4" /></Button>
                    </div>
                  ))}
                  <div className="p-3 bg-muted rounded text-sm text-right mt-2">
                    <span className="text-muted-foreground">HT: {fmt(ht)} · TVA: {fmt(tva)}</span>
                    <span className="ml-4 font-bold text-base">TTC: {fmt(ttc)}</span>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={() => setOpenCreate(false)}>Annuler</Button>
              <Button onClick={handleCreate}>Créer la facture</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: "CA HT (conformes DGI)", value: fmt(caHT), color: "text-green-600" },
          { label: "Encours clients", value: fmt(encours), color: "text-blue-600" },
          { label: "En analyse DGI", value: String(enAnalyse), color: "text-yellow-600" },
          { label: "Conformes", value: String(conformes.length), color: "text-green-600" },
        ].map(k => (
          <Card key={k.label}><CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground">{k.label}</p>
            <p className={`text-xl font-bold mt-1 ${k.color}`}>{k.value}</p>
          </CardContent></Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>N°</TableHead><TableHead>Client</TableHead><TableHead>Date</TableHead>
                <TableHead>TTC</TableHead><TableHead>Statut DGI</TableHead><TableHead>Paiement</TableHead><TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading
                ? <TableRow><TableCell colSpan={7} className="text-center py-8"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></TableCell></TableRow>
                : factures.length === 0
                ? <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">Aucune facture — créez-en une ou importez via OCR</TableCell></TableRow>
                : factures.map(f => (
                  <TableRow key={f.id} className={f.statut === "envoyee" || f.statut_dgi === "en_analyse" ? "bg-yellow-50/30 dark:bg-yellow-950/10" : ""}>
                    <TableCell className="font-mono text-xs">{f.numero ?? f.id.slice(0, 8)}</TableCell>
                    <TableCell className="text-sm">
                      <div>
                        {clients.find(c => c.id === f.client_id)?.nom ?? "—"}
                        {!clients.find(c => c.id === f.client_id)?.email && f.client_id && (
                          <span className="ml-2 text-xs text-orange-500 flex items-center gap-1"><Mail className="h-3 w-3" />Email manquant</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{new Date(f.date_facture).toLocaleDateString("fr-MA")}</TableCell>
                    <TableCell className="font-medium">{fmt(Number(f.montant_ttc))}</TableCell>
                    <TableCell><DGIBadge statut={f.statut} statut_dgi={f.statut_dgi} /></TableCell>
                    <TableCell>
                      <Badge variant={f.statut_paiement === "payee" ? "default" : "secondary"}>
                        {f.statut_paiement === "payee" ? "✅ Payée" : "En attente"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 flex-wrap">
                        {f.statut === "brouillon" && (
                          <Button size="sm" variant="outline" disabled={processing === f.id} onClick={() => handleGenXml(f)}>
                            {processing === f.id ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <FileCode className="h-3 w-3 mr-1" />}
                            e-Facture
                          </Button>
                        )}
                        {f.statut === "conforme" && f.statut_paiement !== "payee" && (
                          <Button size="sm" variant="outline" disabled={processing === f.id} onClick={() => handlePay(f.id)}>
                            <CheckCircle className="h-3 w-3 mr-1" />Payée
                          </Button>
                        )}
                        {f.xml_ubl && (
                          <Button size="sm" variant="ghost" onClick={() => setViewXml(f)} title="Voir XML UBL"><Eye className="h-3 w-3" /></Button>
                        )}
                        {f.fichier_original_url && (
                          <Button size="sm" variant="ghost" onClick={() => viewOriginal(f)} title="Voir fichier original">
                            <FileText className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!emailModal} onOpenChange={() => { setEmailModal(null); setEmailInput(""); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Email client manquant</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              L'email du client est requis pour envoyer la facture.
            </p>
            <div className="space-y-2 mt-4">
              <Label>Adresse email</Label>
              <Input 
                type="email" 
                placeholder="client@exemple.ma" 
                value={emailInput} 
                onChange={(e) => setEmailInput(e.target.value)} 
              />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setEmailModal(null)}>Plus tard</Button>
            <Button onClick={handleAddEmail}>Enregistrer et continuer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}