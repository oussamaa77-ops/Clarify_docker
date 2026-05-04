import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Upload, Loader2, CheckCircle, Building2, Inbox, FileCode, Eye, AlertCircle, TrendingDown, Wallet } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_app/dossiers/$dossierId/fournisseurs")({ component: FournisseursPage });

interface FactureF {
  id: string; fournisseur_nom: string | null; numero: string | null;
  date_facture: string | null; date_echeance: string | null;
  montant_ht: number; montant_tva: number; montant_ttc: number;
  statut: string; statut_paiement: string; statut_dgi: string;
  xml_ubl: string | null; ocr_data: any;
}

interface XmlParsed {
  fournisseur_nom: string; fournisseur_ice: string | null;
  client_nom: string | null; client_ice: string | null;
  numero: string | null; date_facture: string | null; date_echeance: string | null;
  montant_ht: number; montant_tva: number; montant_ttc: number;
  lignes: Array<{ designation: string; quantite: number; prix_unitaire: number; taux_tva: number }>;
  dgi_uuid: string | null; hash_sha256: string | null; conforme: boolean;
  raw_xml: string;
}

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

// ─── Parser XML UBL côté client ───────────────────────────────────────────────
function parseUBLXml(xmlString: string): XmlParsed {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "application/xml");

  const getText = (selector: string) => doc.querySelector(selector)?.textContent?.trim() ?? null;
  const getAttr = (selector: string, attr: string) => doc.querySelector(selector)?.getAttribute(attr) ?? null;

  // Fournisseur (émetteur)
  const supplierName = getText("AccountingSupplierParty Party PartyName Name") ?? "";
  const supplierICE = getText("AccountingSupplierParty Party PartyTaxScheme CompanyID") ?? null;

  // Client (destinataire)
  const customerName = getText("AccountingCustomerParty Party PartyName Name") ?? null;
  const customerICE = getText("AccountingCustomerParty Party PartyTaxScheme CompanyID") ?? null;

  // Numéro et dates
  const numero = getText("Invoice > ID") ?? getText("ID");
  const dateF = getText("IssueDate");
  const dateE = getText("DueDate");

  // Montants
  const montant_ttc = parseFloat(getText("PayableAmount") ?? "0") || 0;
  const montant_ht = parseFloat(getText("LineExtensionAmount") ?? "0") || 0;
  const montant_tva = parseFloat(getText("TaxAmount") ?? "0") || 0;

  // Lignes
  const lines = doc.querySelectorAll("InvoiceLine");
  const lignes = Array.from(lines).map(line => ({
    designation: line.querySelector("Item Name")?.textContent?.trim() ?? "Prestation",
    quantite: parseFloat(line.querySelector("InvoicedQuantity")?.textContent ?? "1") || 1,
    prix_unitaire: parseFloat(line.querySelector("PriceAmount")?.textContent ?? "0") || 0,
    taux_tva: parseFloat(line.querySelector("TaxCategory Percent")?.textContent ?? "20") || 20,
  }));

  // DGI metadata
  const dgi_uuid = getText("CustomizationID")?.includes("DGI") ? null : null; // sera dans les metadata
  const conforme = xmlString.includes("DGI-MA:2026:1.0");

  return {
    fournisseur_nom: supplierName, fournisseur_ice: supplierICE,
    client_nom: customerName, client_ice: customerICE,
    numero, date_facture: dateF, date_echeance: dateE,
    montant_ht, montant_tva, montant_ttc, lignes,
    dgi_uuid, hash_sha256: null, conforme,
    raw_xml: xmlString,
  };
}

function FournisseursPage() {
  const { dossierId } = Route.useParams();

  const [tab, setTab] = useState<"reception" | "factures" | "tiers">("reception");
  const [factures, setFactures] = useState<FactureF[]>([]);
  const [fournisseurs, setFournisseurs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  // Boîte de réception
  const [xmlQueue, setXmlQueue] = useState<XmlParsed[]>([]);
  const [xmlUploading, setXmlUploading] = useState(false);
  const [previewXml, setPreviewXml] = useState<XmlParsed | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Fournisseur tiers
  const [openFourn, setOpenFourn] = useState(false);
  const [formFourn, setFormFourn] = useState({ nom: "", ice: "", email: "", telephone: "", adresse: "" });

  // Vue XML
  const [viewXmlFact, setViewXmlFact] = useState<FactureF | null>(null);

  const load = async () => {
    setLoading(true);
    const [{ data: ff }, { data: fs }] = await Promise.all([
      supabase.from("factures_fournisseurs").select("*").eq("dossier_id", dossierId).order("created_at", { ascending: false }),
      supabase.from("fournisseurs").select("*").eq("dossier_id", dossierId).is("deleted_at", null).order("nom"),
    ]);
    setFactures((ff ?? []) as FactureF[]);
    setFournisseurs(fs ?? []);
    setLoading(false);
  };
  useEffect(() => { load(); }, [dossierId]);

  // ── Réception XML ──────────────────────────────────────────────────────────
  const handleXmlUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    setXmlUploading(true);
    const newItems: XmlParsed[] = [];
    for (const file of Array.from(files)) {
      if (!file.name.endsWith(".xml")) { toast.error(`${file.name} n'est pas un XML`); continue; }
      try {
        const text = await file.text();
        const parsed = parseUBLXml(text);
        if (!parsed.conforme) {
          toast.warning(`${file.name} — namespace DGI-MA manquant, vérifiez la source`);
        }
        newItems.push(parsed);
      } catch { toast.error(`Erreur lecture ${file.name}`); }
    }
    setXmlQueue(q => [...q, ...newItems]);
    setXmlUploading(false);
    if (newItems.length) toast.success(`${newItems.length} facture(s) XML reçue(s) — validez pour enregistrer`);
  };

  // ── Valider et enregistrer une facture XML ─────────────────────────────────
  const handleValider = async (parsed: XmlParsed) => {
    setProcessing(parsed.numero ?? "new");
    try {
      // Trouver ou créer le fournisseur
      let fournisseur_id: string | null = null;
      if (parsed.fournisseur_ice) {
        const { data: existing } = await supabase.from("fournisseurs").select("id")
          .eq("dossier_id", dossierId).eq("ice", parsed.fournisseur_ice).maybeSingle();
        if (existing) { fournisseur_id = existing.id; }
        else {
          const { data: nouveau } = await supabase.from("fournisseurs").insert({
            dossier_id: dossierId, nom: parsed.fournisseur_nom,
            ice: parsed.fournisseur_ice,
          }).select("id").single();
          if (nouveau) fournisseur_id = nouveau.id;
        }
      }

      // Enregistrer la facture fournisseur
      const { error } = await supabase.from("factures_fournisseurs").insert({
        dossier_id: dossierId,
        fournisseur_id,
        fournisseur_nom: parsed.fournisseur_nom,
        numero: parsed.numero,
        date_facture: parsed.date_facture,
        date_echeance: parsed.date_echeance,
        montant_ht: parsed.montant_ht,
        montant_tva: parsed.montant_tva,
        montant_ttc: parsed.montant_ttc,
        statut: "recue",
        statut_dgi: parsed.conforme ? "conforme" : "non_conforme",
        statut_paiement: "non_payee",
        xml_ubl: parsed.raw_xml,
        ocr_data: { lignes: parsed.lignes, fournisseur_ice: parsed.fournisseur_ice },
      });
      if (error) throw error;

      // Écritures comptables (seulement si conforme)
      if (parsed.conforme && parsed.montant_ttc > 0) {
        const today = parsed.date_facture ?? new Date().toISOString().slice(0, 10);
        await supabase.from("ecritures_comptables").insert([
          { dossier_id: dossierId, journal_code: "ACH", compte_numero: "6141", date_ecriture: today, libelle: `Achat ${parsed.fournisseur_nom} ${parsed.numero ?? ""}`, debit: parsed.montant_ht, credit: 0, valide: true },
          { dossier_id: dossierId, journal_code: "ACH", compte_numero: "34552", date_ecriture: today, libelle: `TVA récupérable ${parsed.fournisseur_nom}`, debit: parsed.montant_tva, credit: 0, valide: true },
          { dossier_id: dossierId, journal_code: "ACH", compte_numero: "4411", date_ecriture: today, libelle: `Dette fournisseur ${parsed.fournisseur_nom}`, debit: 0, credit: parsed.montant_ttc, valide: true },
        ]);
      }

      // Audit
      await supabase.from("audit_logs").insert({
        dossier_id: dossierId, action: "facture_fournisseur_recue",
        ressource_type: "facture_fournisseur",
        details: { fournisseur: parsed.fournisseur_nom, numero: parsed.numero, montant_ttc: parsed.montant_ttc },
      });

      // Retirer de la queue
      setXmlQueue(q => q.filter(x => x !== parsed));
      setPreviewXml(null);
      toast.success(`Facture ${parsed.numero ?? ""} enregistrée — écritures comptables créées`);
      load();
      if (xmlQueue.length <= 1) setTab("factures");
    } catch (e: any) { toast.error(e.message); }
    finally { setProcessing(null); }
  };

  // ── Payer une facture fournisseur ──────────────────────────────────────────
  const handlePayer = async (f: FactureF) => {
    setProcessing(f.id);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await supabase.from("factures_fournisseurs").update({ statut: "payee", statut_paiement: "payee", date_paiement: today } as any).eq("id", f.id);
      await supabase.from("ecritures_comptables").insert([
        { dossier_id: dossierId, journal_code: "BQ", compte_numero: "4411", date_ecriture: today, libelle: `Règlement ${f.fournisseur_nom}`, debit: f.montant_ttc, credit: 0, valide: true },
        { dossier_id: dossierId, journal_code: "BQ", compte_numero: "5141", date_ecriture: today, libelle: `Paiement ${f.fournisseur_nom}`, debit: 0, credit: f.montant_ttc, valide: true },
      ]);
      toast.success("Facture payée + écriture banque créée");
      load();
    } catch (e: any) { toast.error(e.message); }
    finally { setProcessing(null); }
  };

  // KPIs
  const dettes = factures.filter(f => f.statut_paiement !== "payee").reduce((s, f) => s + Number(f.montant_ttc), 0);
  const depenses = factures.reduce((s, f) => s + Number(f.montant_ht), 0);
  const enAttente = factures.filter(f => f.statut_paiement !== "payee").length;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold">Factures fournisseurs</h1>
          <p className="text-muted-foreground mt-1">Réception XML UBL · Validation · Comptabilisation automatique</p>
        </div>
        <div className="flex gap-2">
          {/* Upload XML */}
          <div className="relative">
            <input ref={fileRef} type="file" accept=".xml" multiple className="hidden"
              onChange={e => handleXmlUpload(e.target.files)} />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={xmlUploading}>
              {xmlUploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
              Recevoir XML fournisseur
              {xmlQueue.length > 0 && <span className="ml-2 bg-blue-500 text-white text-xs px-1.5 py-0.5 rounded-full">{xmlQueue.length}</span>}
            </Button>
          </div>
          {/* Nouveau fournisseur tiers */}
          <Button variant="ghost" onClick={() => setOpenFourn(true)}><Plus className="h-4 w-4 mr-1" />Fournisseur</Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: "Dépenses HT totales", value: fmt(depenses), icon: TrendingDown, color: "text-orange-600" },
          { label: "Dettes fournisseurs", value: fmt(dettes), icon: Wallet, color: "text-red-600" },
          { label: "Factures en attente", value: String(enAttente), icon: AlertCircle, color: "text-yellow-600" },
        ].map(k => (
          <Card key={k.label}><CardContent className="pt-4 pb-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className={`text-xl font-bold mt-1 ${k.color}`}>{k.value}</p>
            </div>
            <k.icon className={`h-8 w-8 ${k.color} opacity-30`} />
          </CardContent></Card>
        ))}
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="reception">
            <Inbox className="h-4 w-4 mr-2" />Boîte de réception
            {xmlQueue.length > 0 && <span className="ml-2 bg-blue-500 text-white text-xs px-1.5 py-0.5 rounded-full">{xmlQueue.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="factures">Factures reçues ({factures.length})</TabsTrigger>
          <TabsTrigger value="tiers">Fournisseurs ({fournisseurs.length})</TabsTrigger>
        </TabsList>

        {/* ── Boîte de réception ── */}
        <TabsContent value="reception" className="mt-4">
          {xmlQueue.length === 0 ? (
            <Card>
              <CardContent className="py-16 text-center">
                <Inbox className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-30" />
                <p className="font-medium text-muted-foreground mb-2">Aucune facture en attente</p>
                <p className="text-sm text-muted-foreground mb-6">
                  Cliquez sur "Recevoir XML fournisseur" pour charger les fichiers XML UBL envoyés par vos fournisseurs.
                </p>
                <div className="max-w-md mx-auto p-4 bg-blue-50 dark:bg-blue-950/20 rounded-lg text-xs text-blue-700 dark:text-blue-300 text-left">
                  <p className="font-medium mb-2">📋 Flux de réception :</p>
                  <p>1. Votre fournisseur génère sa facture sur son SaaS</p>
                  <p>2. Il l'envoie via DGI/AJAL → vous recevez le XML conforme</p>
                  <p>3. Vous chargez le fichier XML ici</p>
                  <p>4. Vous validez → écritures PCM créées automatiquement</p>
                </div>
                <Button className="mt-6" onClick={() => fileRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />Charger des fichiers XML
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {xmlQueue.map((parsed, idx) => (
                <Card key={idx} className={parsed.conforme ? "border-green-200 dark:border-green-800" : "border-yellow-200 dark:border-yellow-800"}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          <span className="font-semibold">{parsed.fournisseur_nom}</span>
                          {parsed.fournisseur_ice && <span className="font-mono text-xs text-muted-foreground">ICE: {parsed.fournisseur_ice}</span>}
                        </div>
                        <div className="flex items-center gap-3 text-sm text-muted-foreground">
                          {parsed.numero && <span>N° {parsed.numero}</span>}
                          {parsed.date_facture && <span>Date: {new Date(parsed.date_facture).toLocaleDateString("fr-MA")}</span>}
                          {parsed.date_echeance && <span>Échéance: {new Date(parsed.date_echeance).toLocaleDateString("fr-MA")}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={parsed.conforme ? "default" : "secondary"}>
                          {parsed.conforme ? "✅ UBL conforme" : "⚠️ À vérifier"}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {/* Montants */}
                    <div className="grid grid-cols-3 gap-3 mb-4">
                      <div className="bg-muted rounded-lg p-3 text-center">
                        <p className="text-xs text-muted-foreground">Montant HT</p>
                        <p className="font-bold">{fmt(parsed.montant_ht)}</p>
                      </div>
                      <div className="bg-muted rounded-lg p-3 text-center">
                        <p className="text-xs text-muted-foreground">TVA</p>
                        <p className="font-bold">{fmt(parsed.montant_tva)}</p>
                      </div>
                      <div className="bg-blue-50 dark:bg-blue-950/20 rounded-lg p-3 text-center">
                        <p className="text-xs text-muted-foreground">Total TTC</p>
                        <p className="font-bold text-primary">{fmt(parsed.montant_ttc)}</p>
                      </div>
                    </div>

                    {/* Lignes */}
                    {parsed.lignes?.length > 0 && (
                      <div className="rounded border overflow-hidden mb-4">
                        <Table>
                          <TableHeader>
                            <TableRow><TableHead>Désignation</TableHead><TableHead>Qté</TableHead><TableHead>PU</TableHead><TableHead>TVA</TableHead></TableRow>
                          </TableHeader>
                          <TableBody>
                            {parsed.lignes.map((l, i) => (
                              <TableRow key={i}>
                                <TableCell className="text-sm">{l.designation}</TableCell>
                                <TableCell className="font-mono text-sm">{l.quantite}</TableCell>
                                <TableCell className="font-mono text-sm">{fmt(l.prix_unitaire)}</TableCell>
                                <TableCell className="text-sm">{l.taux_tva}%</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button onClick={() => handleValider(parsed)} disabled={processing === (parsed.numero ?? "new")} className="flex-1">
                        {processing === (parsed.numero ?? "new") ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-2" />}
                        Valider et enregistrer
                      </Button>
                      <Button variant="outline" onClick={() => setPreviewXml(parsed)}>
                        <Eye className="h-4 w-4 mr-1" />XML
                      </Button>
                      <Button variant="ghost" onClick={() => setXmlQueue(q => q.filter((_, i) => i !== idx))}>
                        Ignorer
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Factures enregistrées ── */}
        <TabsContent value="factures" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Fournisseur</TableHead><TableHead>N°</TableHead><TableHead>Date</TableHead>
                <TableHead>HT</TableHead><TableHead>TTC</TableHead><TableHead>DGI</TableHead>
                <TableHead>Paiement</TableHead><TableHead>Actions</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {loading
                  ? <TableRow><TableCell colSpan={8} className="text-center py-8"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></TableCell></TableRow>
                  : factures.length === 0
                  ? <TableRow><TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                      <Inbox className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      Aucune facture — chargez des fichiers XML dans la boîte de réception
                    </TableCell></TableRow>
                  : factures.map(f => (
                    <TableRow key={f.id}>
                      <TableCell className="font-medium">{f.fournisseur_nom}</TableCell>
                      <TableCell className="font-mono text-xs">{f.numero ?? "—"}</TableCell>
                      <TableCell className="text-sm">{f.date_facture ? new Date(f.date_facture).toLocaleDateString("fr-MA") : "—"}</TableCell>
                      <TableCell className="font-mono text-sm">{fmt(Number(f.montant_ht))}</TableCell>
                      <TableCell className="font-medium">{fmt(Number(f.montant_ttc))}</TableCell>
                      <TableCell>
                        <Badge variant={f.statut_dgi === "conforme" ? "default" : "secondary"}>
                          {f.statut_dgi === "conforme" ? "✅ Conforme" : f.statut_dgi}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={f.statut_paiement === "payee" ? "default" : f.statut_paiement === "en_retard" ? "destructive" : "secondary"}>
                          {f.statut_paiement === "payee" ? "✅ Payée" : "En attente"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {f.statut_paiement !== "payee" && (
                            <Button size="sm" variant="outline" disabled={processing === f.id} onClick={() => handlePayer(f)}>
                              {processing === f.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3 mr-1" />}Payer
                            </Button>
                          )}
                          {f.xml_ubl && (
                            <Button size="sm" variant="ghost" onClick={() => setViewXmlFact(f)}><Eye className="h-3 w-3" /></Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>

        {/* ── Fournisseurs tiers ── */}
        <TabsContent value="tiers" className="mt-4">
          <Card><CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>Nom</TableHead><TableHead>ICE</TableHead><TableHead>Email</TableHead><TableHead>Téléphone</TableHead></TableRow></TableHeader>
              <TableBody>
                {fournisseurs.length === 0
                  ? <TableRow><TableCell colSpan={4} className="text-center py-10 text-muted-foreground">
                      <Building2 className="h-8 w-8 mx-auto mb-2 opacity-30" />Les fournisseurs sont créés automatiquement à la validation des factures XML
                    </TableCell></TableRow>
                  : fournisseurs.map(f => (
                    <TableRow key={f.id}>
                      <TableCell className="font-medium">{f.nom}</TableCell>
                      <TableCell className="font-mono text-xs">{f.ice ?? "—"}</TableCell>
                      <TableCell className="text-sm">{f.email ?? "—"}</TableCell>
                      <TableCell className="text-sm">{f.telephone ?? "—"}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </CardContent></Card>
        </TabsContent>
      </Tabs>

      {/* Preview XML boîte réception */}
      <Dialog open={!!previewXml} onOpenChange={() => setPreviewXml(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>XML UBL — {previewXml?.numero}</DialogTitle></DialogHeader>
          <pre className="bg-muted p-4 rounded text-xs overflow-auto max-h-96 font-mono whitespace-pre-wrap">{previewXml?.raw_xml}</pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewXml(null)}>Fermer</Button>
            {previewXml && <Button onClick={() => { handleValider(previewXml); }}><CheckCircle className="h-4 w-4 mr-2" />Valider</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Vue XML facture enregistrée */}
      <Dialog open={!!viewXmlFact} onOpenChange={() => setViewXmlFact(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>XML UBL — {viewXmlFact?.numero}</DialogTitle></DialogHeader>
          <pre className="bg-muted p-4 rounded text-xs overflow-auto max-h-96 font-mono whitespace-pre-wrap">{viewXmlFact?.xml_ubl}</pre>
        </DialogContent>
      </Dialog>

      {/* Modal nouveau fournisseur */}
      <Dialog open={openFourn} onOpenChange={setOpenFourn}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nouveau fournisseur</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2"><Label>Nom *</Label><Input required value={formFourn.nom} onChange={e => setFormFourn({ ...formFourn, nom: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2"><Label>ICE</Label><Input value={formFourn.ice} onChange={e => setFormFourn({ ...formFourn, ice: e.target.value })} /></div>
              <div className="space-y-2"><Label>Email</Label><Input type="email" value={formFourn.email} onChange={e => setFormFourn({ ...formFourn, email: e.target.value })} /></div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenFourn(false)}>Annuler</Button>
            <Button onClick={async () => {
              if (!formFourn.nom) return;
              await supabase.from("fournisseurs").insert({ dossier_id: dossierId, ...formFourn, ice: formFourn.ice || null, email: formFourn.email || null });
              setOpenFourn(false); setFormFourn({ nom: "", ice: "", email: "", telephone: "", adresse: "" }); load();
              toast.success("Fournisseur créé");
            }}>Créer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
