import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Wallet, FileText, ShoppingCart, AlertCircle, CheckCircle } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

export const Route = createFileRoute("/_app/dossiers/$dossierId/dashboard")({ component: DashboardPage });

const fmt = (n: number) => Number(n).toLocaleString("fr-MA", { minimumFractionDigits: 2 }) + " MAD";

function DashboardPage() {
  const { dossierId } = Route.useParams();
  const [dossier, setDossier] = useState<any>(null);
  const [factures, setFactures] = useState<any[]>([]);
  const [ff, setFf] = useState<any[]>([]);
  const [alertes, setAlertes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [{ data: d }, { data: f }, { data: ffData }, { data: al }] = await Promise.all([
        supabase.from("dossiers").select("nom_societe,ice,statut").eq("id", dossierId).single(),
        supabase.from("factures").select("statut,statut_paiement,montant_ht,montant_ttc,montant_tva,date_facture,date_echeance").eq("dossier_id", dossierId),
        supabase.from("factures_fournisseurs").select("statut_paiement,montant_ttc").eq("dossier_id", dossierId),
        supabase.from("alertes").select("*").eq("dossier_id", dossierId).eq("lue", false).order("created_at", { ascending: false }).limit(5),
      ]);
      setDossier(d);
      setFactures(f ?? []);
      setFf(ffData ?? []);
      setAlertes(al ?? []);
      setLoading(false);
    })();
  }, [dossierId]);

  // ── KPIs corrigés ─────────────────────────────────────────────────────────
  const conformes = factures.filter(f => f.statut === "conforme");

  // CA HT = base de calcul fiscale (hors TVA)
  const caHT = conformes.reduce((s, f) => s + Number(f.montant_ht), 0);

  // CA TTC = montant total facturé
  const caTTC = conformes.reduce((s, f) => s + Number(f.montant_ttc), 0);

  // CA encaissé = factures conformes ET payées (vrai revenu reçu)
  const caEncaisse = conformes
    .filter(f => f.statut_paiement === "payee")
    .reduce((s, f) => s + Number(f.montant_ttc), 0);

  // Encours = factures conformes NON payées (créances clients)
  const encours = conformes
    .filter(f => f.statut_paiement !== "payee")
    .reduce((s, f) => s + Number(f.montant_ttc), 0);

  const tvaCollectee = conformes.reduce((s, f) => s + Number(f.montant_tva), 0);
  const dettes = ff.filter(f => f.statut_paiement !== "payee").reduce((s, f) => s + Number(f.montant_ttc), 0);
  const enAnalyse = factures.filter(f => f.statut === "envoyee").length;

  // ── Graphe 6 mois — 2 séries : CA HT facturé + Encaissé ─────────────────
  const now = new Date();
  const chartData = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    const mois = d.toLocaleDateString("fr-MA", { month: "short", year: "2-digit" });
    const m = d.getMonth();
    const y = d.getFullYear();

    const caHtMois = factures
      .filter(f => {
        const fd = new Date(f.date_facture);
        return fd.getMonth() === m && fd.getFullYear() === y && f.statut === "conforme";
      })
      .reduce((s, f) => s + Number(f.montant_ht), 0);

    const encaisseMois = factures
      .filter(f => {
        const fd = new Date(f.date_facture);
        return fd.getMonth() === m && fd.getFullYear() === y
          && f.statut === "conforme" && f.statut_paiement === "payee";
      })
      .reduce((s, f) => s + Number(f.montant_ttc), 0);

    return { mois, caHT: Math.round(caHtMois), encaisse: Math.round(encaisseMois) };
  });

  const kpis = [
    { icon: TrendingUp, label: "CA HT facturé (conformes DGI)", value: fmt(caHT), sub: `TTC: ${fmt(caTTC)}`, color: "text-green-600" },
    { icon: Wallet, label: "CA encaissé (payées)", value: fmt(caEncaisse), color: "text-emerald-600" },
    { icon: FileText, label: "Encours clients (à encaisser)", value: fmt(encours), color: "text-blue-600" },
    { icon: ShoppingCart, label: "Dettes fournisseurs", value: fmt(dettes), color: "text-orange-600" },
    { icon: CheckCircle, label: "TVA collectée", value: fmt(tvaCollectee), color: "text-purple-600" },
    { icon: AlertCircle, label: "En analyse DGI", value: String(enAnalyse), color: "text-yellow-600" },
  ];

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">{dossier?.nom_societe ?? "Dashboard"}</h1>
        <div className="flex items-center gap-3 mt-1">
          {dossier?.ice && <span className="font-mono text-xs text-muted-foreground">ICE: {dossier.ice}</span>}
          <Badge variant="outline" className="text-green-600">{dossier?.statut}</Badge>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {Array(6).fill(0).map((_, i) => <div key={i} className="h-24 bg-muted rounded-xl animate-pulse" />)}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {kpis.map(k => (
              <Card key={k.label}><CardContent className="pt-5 pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">{k.label}</p>
                    <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
                    {(k as any).sub && <p className="text-xs text-muted-foreground mt-0.5">{(k as any).sub}</p>}
                  </div>
                  <k.icon className={`h-8 w-8 ${k.color} opacity-40`} />
                </div>
              </CardContent></Card>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle className="text-base">Chiffre d'affaires — 6 mois</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#2563eb" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorEnc" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="mois" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v: any, name: string) => [fmt(v), name === "caHT" ? "CA HT facturé" : "Encaissé TTC"]} />
                    <Legend formatter={(v: string) => v === "caHT" ? "CA HT facturé" : "Encaissé TTC"} />
                    <Area type="monotone" dataKey="caHT" stroke="#2563eb" strokeWidth={2} fill="url(#colorRev)" name="caHT" />
                    <Area type="monotone" dataKey="encaisse" stroke="#10b981" strokeWidth={2} fill="url(#colorEnc)" name="encaisse" />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Alertes</CardTitle></CardHeader>
              <CardContent>
                {alertes.length === 0 ? (
                  <div className="text-center py-6 text-muted-foreground text-sm">
                    <CheckCircle className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    Aucune alerte active
                  </div>
                ) : alertes.map(a => (
                  <div key={a.id} className={`p-3 rounded-lg mb-2 text-sm ${a.type === "danger" ? "bg-red-50 dark:bg-red-950/20 text-red-700" : "bg-yellow-50 dark:bg-yellow-950/20 text-yellow-700"}`}>
                    <p className="font-medium">{a.titre}</p>
                    {a.message && <p className="text-xs opacity-80 mt-0.5">{a.message}</p>}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
