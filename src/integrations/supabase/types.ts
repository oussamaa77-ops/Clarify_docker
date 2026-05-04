export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      alertes: {
        Row: {
          created_at: string
          dossier_id: string
          id: string
          lue: boolean
          message: string | null
          titre: string | null
          type: string | null
        }
        Insert: {
          created_at?: string
          dossier_id: string
          id?: string
          lue?: boolean
          message?: string | null
          titre?: string | null
          type?: string | null
        }
        Update: {
          created_at?: string
          dossier_id?: string
          id?: string
          lue?: boolean
          message?: string | null
          titre?: string | null
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "alertes_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          details: Json | null
          dossier_id: string | null
          hash: string | null
          hash_precedent: string | null
          id: string
          ressource_id: string | null
          ressource_type: string | null
          user_email: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          details?: Json | null
          dossier_id?: string | null
          hash?: string | null
          hash_precedent?: string | null
          id?: string
          ressource_id?: string | null
          ressource_type?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          details?: Json | null
          dossier_id?: string | null
          hash?: string | null
          hash_precedent?: string | null
          id?: string
          ressource_id?: string | null
          ressource_type?: string | null
          user_email?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
        ]
      }
      cabinets: {
        Row: {
          adresse: string | null
          created_at: string
          email: string | null
          id: string
          nom: string
          telephone: string | null
        }
        Insert: {
          adresse?: string | null
          created_at?: string
          email?: string | null
          id?: string
          nom: string
          telephone?: string | null
        }
        Update: {
          adresse?: string | null
          created_at?: string
          email?: string | null
          id?: string
          nom?: string
          telephone?: string | null
        }
        Relationships: []
      }
      clients: {
        Row: {
          adresse: string | null
          created_at: string
          deleted_at: string | null
          dossier_id: string
          email: string | null
          ice: string | null
          id: string
          if_fiscal: string | null
          nom: string
          rc: string | null
          telephone: string | null
        }
        Insert: {
          adresse?: string | null
          created_at?: string
          deleted_at?: string | null
          dossier_id: string
          email?: string | null
          ice?: string | null
          id?: string
          if_fiscal?: string | null
          nom: string
          rc?: string | null
          telephone?: string | null
        }
        Update: {
          adresse?: string | null
          created_at?: string
          deleted_at?: string | null
          dossier_id?: string
          email?: string | null
          ice?: string | null
          id?: string
          if_fiscal?: string | null
          nom?: string
          rc?: string | null
          telephone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
        ]
      }
      comptes_bancaires: {
        Row: {
          banque: string | null
          created_at: string
          dossier_id: string
          iban: string | null
          id: string
          intitule: string | null
          rib: string | null
          solde_actuel: number
        }
        Insert: {
          banque?: string | null
          created_at?: string
          dossier_id: string
          iban?: string | null
          id?: string
          intitule?: string | null
          rib?: string | null
          solde_actuel?: number
        }
        Update: {
          banque?: string | null
          created_at?: string
          dossier_id?: string
          iban?: string | null
          id?: string
          intitule?: string | null
          rib?: string | null
          solde_actuel?: number
        }
        Relationships: [
          {
            foreignKeyName: "comptes_bancaires_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
        ]
      }
      comptes_comptables: {
        Row: {
          created_at: string
          dossier_id: string
          id: string
          intitule: string
          numero: string
          solde_initial: number
          type_compte: string | null
        }
        Insert: {
          created_at?: string
          dossier_id: string
          id?: string
          intitule: string
          numero: string
          solde_initial?: number
          type_compte?: string | null
        }
        Update: {
          created_at?: string
          dossier_id?: string
          id?: string
          intitule?: string
          numero?: string
          solde_initial?: number
          type_compte?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comptes_comptables_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
        ]
      }
      dossier_access: {
        Row: {
          created_at: string
          dossier_id: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          dossier_id: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          dossier_id?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dossier_access_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
        ]
      }
      dossiers: {
        Row: {
          adresse: string | null
          cabinet_id: string
          created_at: string
          created_by: string | null
          email_societe: string | null
          ice: string | null
          id: string
          if_fiscal: string | null
          nom_societe: string
          rc: string | null
          statut: string
          telephone: string | null
          updated_at: string
        }
        Insert: {
          adresse?: string | null
          cabinet_id: string
          created_at?: string
          created_by?: string | null
          email_societe?: string | null
          ice?: string | null
          id?: string
          if_fiscal?: string | null
          nom_societe: string
          rc?: string | null
          statut?: string
          telephone?: string | null
          updated_at?: string
        }
        Update: {
          adresse?: string | null
          cabinet_id?: string
          created_at?: string
          created_by?: string | null
          email_societe?: string | null
          ice?: string | null
          id?: string
          if_fiscal?: string | null
          nom_societe?: string
          rc?: string | null
          statut?: string
          telephone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dossiers_cabinet_id_fkey"
            columns: ["cabinet_id"]
            isOneToOne: false
            referencedRelation: "cabinets"
            referencedColumns: ["id"]
          },
        ]
      }
      ecritures_comptables: {
        Row: {
          compte_numero: string | null
          created_at: string
          credit: number
          date_ecriture: string
          debit: number
          dossier_id: string
          facture_id: string | null
          id: string
          journal_code: string | null
          libelle: string | null
          reference_piece: string | null
          valide: boolean
        }
        Insert: {
          compte_numero?: string | null
          created_at?: string
          credit?: number
          date_ecriture: string
          debit?: number
          dossier_id: string
          facture_id?: string | null
          id?: string
          journal_code?: string | null
          libelle?: string | null
          reference_piece?: string | null
          valide?: boolean
        }
        Update: {
          compte_numero?: string | null
          created_at?: string
          credit?: number
          date_ecriture?: string
          debit?: number
          dossier_id?: string
          facture_id?: string | null
          id?: string
          journal_code?: string | null
          libelle?: string | null
          reference_piece?: string | null
          valide?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "ecritures_comptables_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ecritures_comptables_facture_id_fkey"
            columns: ["facture_id"]
            isOneToOne: false
            referencedRelation: "factures"
            referencedColumns: ["id"]
          },
        ]
      }
      factures: {
        Row: {
          client_id: string | null
          created_at: string
          created_by: string | null
          date_echeance: string | null
          date_facture: string
          date_paiement: string | null
          dgi_response: Json | null
          dgi_uuid: string | null
          dossier_id: string
          hash_sha256: string | null
          id: string
          lignes: Json
          montant_ht: number
          montant_ttc: number
          montant_tva: number
          notes: string | null
          numero: string | null
          statut: Database["public"]["Enums"]["statut_facture"]
          statut_dgi: string | null
          statut_paiement: Database["public"]["Enums"]["statut_paiement"]
          type: Database["public"]["Enums"]["type_facture"]
          updated_at: string
          xml_ubl: string | null
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          date_echeance?: string | null
          date_facture: string
          date_paiement?: string | null
          dgi_response?: Json | null
          dgi_uuid?: string | null
          dossier_id: string
          hash_sha256?: string | null
          id?: string
          lignes?: Json
          montant_ht?: number
          montant_ttc?: number
          montant_tva?: number
          notes?: string | null
          numero?: string | null
          statut?: Database["public"]["Enums"]["statut_facture"]
          statut_dgi?: string | null
          statut_paiement?: Database["public"]["Enums"]["statut_paiement"]
          type?: Database["public"]["Enums"]["type_facture"]
          updated_at?: string
          xml_ubl?: string | null
        }
        Update: {
          client_id?: string | null
          created_at?: string
          created_by?: string | null
          date_echeance?: string | null
          date_facture?: string
          date_paiement?: string | null
          dgi_response?: Json | null
          dgi_uuid?: string | null
          dossier_id?: string
          hash_sha256?: string | null
          id?: string
          lignes?: Json
          montant_ht?: number
          montant_ttc?: number
          montant_tva?: number
          notes?: string | null
          numero?: string | null
          statut?: Database["public"]["Enums"]["statut_facture"]
          statut_dgi?: string | null
          statut_paiement?: Database["public"]["Enums"]["statut_paiement"]
          type?: Database["public"]["Enums"]["type_facture"]
          updated_at?: string
          xml_ubl?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "factures_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factures_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
        ]
      }
      factures_fournisseurs: {
        Row: {
          created_at: string
          date_echeance: string | null
          date_facture: string | null
          date_paiement: string | null
          dgi_uuid: string | null
          dossier_id: string
          fournisseur_id: string | null
          fournisseur_nom: string | null
          hash_sha256: string | null
          id: string
          montant_ht: number
          montant_ttc: number
          montant_tva: number
          numero: string | null
          ocr_data: Json | null
          statut: string
          statut_dgi: string
          statut_paiement: Database["public"]["Enums"]["statut_paiement"]
          xml_ubl: string | null
        }
        Insert: {
          created_at?: string
          date_echeance?: string | null
          date_facture?: string | null
          date_paiement?: string | null
          dgi_uuid?: string | null
          dossier_id: string
          fournisseur_id?: string | null
          fournisseur_nom?: string | null
          hash_sha256?: string | null
          id?: string
          montant_ht?: number
          montant_ttc?: number
          montant_tva?: number
          numero?: string | null
          ocr_data?: Json | null
          statut?: string
          statut_dgi?: string
          statut_paiement?: Database["public"]["Enums"]["statut_paiement"]
          xml_ubl?: string | null
        }
        Update: {
          created_at?: string
          date_echeance?: string | null
          date_facture?: string | null
          date_paiement?: string | null
          dgi_uuid?: string | null
          dossier_id?: string
          fournisseur_id?: string | null
          fournisseur_nom?: string | null
          hash_sha256?: string | null
          id?: string
          montant_ht?: number
          montant_ttc?: number
          montant_tva?: number
          numero?: string | null
          ocr_data?: Json | null
          statut?: string
          statut_dgi?: string
          statut_paiement?: Database["public"]["Enums"]["statut_paiement"]
          xml_ubl?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "factures_fournisseurs_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "factures_fournisseurs_fournisseur_id_fkey"
            columns: ["fournisseur_id"]
            isOneToOne: false
            referencedRelation: "fournisseurs"
            referencedColumns: ["id"]
          },
        ]
      }
      fournisseurs: {
        Row: {
          adresse: string | null
          created_at: string
          deleted_at: string | null
          dossier_id: string
          email: string | null
          ice: string | null
          id: string
          if_fiscal: string | null
          nom: string
          rc: string | null
          telephone: string | null
        }
        Insert: {
          adresse?: string | null
          created_at?: string
          deleted_at?: string | null
          dossier_id: string
          email?: string | null
          ice?: string | null
          id?: string
          if_fiscal?: string | null
          nom: string
          rc?: string | null
          telephone?: string | null
        }
        Update: {
          adresse?: string | null
          created_at?: string
          deleted_at?: string | null
          dossier_id?: string
          email?: string | null
          ice?: string | null
          id?: string
          if_fiscal?: string | null
          nom?: string
          rc?: string | null
          telephone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fournisseurs_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
        ]
      }
      ged_documents: {
        Row: {
          created_at: string
          dgi_uuid: string | null
          dossier_id: string
          facture_id: string | null
          hash_sha256: string | null
          horodatage: string
          id: string
          mime_type: string | null
          nom_fichier: string
          taille_bytes: number | null
          type_document: string | null
          url_stockage: string | null
        }
        Insert: {
          created_at?: string
          dgi_uuid?: string | null
          dossier_id: string
          facture_id?: string | null
          hash_sha256?: string | null
          horodatage?: string
          id?: string
          mime_type?: string | null
          nom_fichier: string
          taille_bytes?: number | null
          type_document?: string | null
          url_stockage?: string | null
        }
        Update: {
          created_at?: string
          dgi_uuid?: string | null
          dossier_id?: string
          facture_id?: string | null
          hash_sha256?: string | null
          horodatage?: string
          id?: string
          mime_type?: string | null
          nom_fichier?: string
          taille_bytes?: number | null
          type_document?: string | null
          url_stockage?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ged_documents_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ged_documents_facture_id_fkey"
            columns: ["facture_id"]
            isOneToOne: false
            referencedRelation: "factures"
            referencedColumns: ["id"]
          },
        ]
      }
      journaux_comptables: {
        Row: {
          code: string
          created_at: string
          dossier_id: string
          id: string
          intitule: string
          type_journal: string | null
        }
        Insert: {
          code: string
          created_at?: string
          dossier_id: string
          id?: string
          intitule: string
          type_journal?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          dossier_id?: string
          id?: string
          intitule?: string
          type_journal?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "journaux_comptables_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          cabinet_id: string | null
          created_at: string
          email: string
          id: string
          nom: string | null
          prenom: string | null
          updated_at: string
        }
        Insert: {
          cabinet_id?: string | null
          created_at?: string
          email: string
          id: string
          nom?: string | null
          prenom?: string | null
          updated_at?: string
        }
        Update: {
          cabinet_id?: string | null
          created_at?: string
          email?: string
          id?: string
          nom?: string | null
          prenom?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_cabinet_id_fkey"
            columns: ["cabinet_id"]
            isOneToOne: false
            referencedRelation: "cabinets"
            referencedColumns: ["id"]
          },
        ]
      }
      transactions_bancaires: {
        Row: {
          compte_id: string
          created_at: string
          date_operation: string
          dossier_id: string
          id: string
          libelle: string | null
          montant: number
          rapproche: boolean
          reference: string | null
          solde_apres: number | null
          type: Database["public"]["Enums"]["type_transaction"]
        }
        Insert: {
          compte_id: string
          created_at?: string
          date_operation: string
          dossier_id: string
          id?: string
          libelle?: string | null
          montant: number
          rapproche?: boolean
          reference?: string | null
          solde_apres?: number | null
          type: Database["public"]["Enums"]["type_transaction"]
        }
        Update: {
          compte_id?: string
          created_at?: string
          date_operation?: string
          dossier_id?: string
          id?: string
          libelle?: string | null
          montant?: number
          rapproche?: boolean
          reference?: string | null
          solde_apres?: number | null
          type?: Database["public"]["Enums"]["type_transaction"]
        }
        Relationships: [
          {
            foreignKeyName: "transactions_bancaires_compte_id_fkey"
            columns: ["compte_id"]
            isOneToOne: false
            referencedRelation: "comptes_bancaires"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_bancaires_dossier_id_fkey"
            columns: ["dossier_id"]
            isOneToOne: false
            referencedRelation: "dossiers"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          cabinet_id: string | null
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          cabinet_id?: string | null
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          cabinet_id?: string | null
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_cabinet_id_fkey"
            columns: ["cabinet_id"]
            isOneToOne: false
            referencedRelation: "cabinets"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_user_cabinet: { Args: { _user_id: string }; Returns: string }
      has_dossier_access: {
        Args: { _dossier_id: string; _user_id: string }
        Returns: boolean
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role:
        | "expert_comptable"
        | "assistant_cabinet"
        | "chef_entreprise"
        | "collaborateur"
      statut_facture:
        | "brouillon"
        | "envoyee"
        | "conforme"
        | "rejetee"
        | "annulee"
      statut_paiement: "non_payee" | "partielle" | "payee" | "en_retard"
      type_facture: "facture" | "avoir" | "proforma"
      type_transaction: "credit" | "debit"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: [
        "expert_comptable",
        "assistant_cabinet",
        "chef_entreprise",
        "collaborateur",
      ],
      statut_facture: [
        "brouillon",
        "envoyee",
        "conforme",
        "rejetee",
        "annulee",
      ],
      statut_paiement: ["non_payee", "partielle", "payee", "en_retard"],
      type_facture: ["facture", "avoir", "proforma"],
      type_transaction: ["credit", "debit"],
    },
  },
} as const
