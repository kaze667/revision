// Configuration de l'appli Révisions espacées.
// Remplace les trois valeurs ci-dessous (voir le guide d'installation, étapes 2 et 4).
// Ces valeurs sont publiques par nature : la clé "anon" ne donne accès qu'aux données
// de l'utilisateur connecté, grâce aux règles de sécurité (RLS) du script SQL.
window.REVI_CONFIG = {
  // Supabase > Project Settings > API > Project URL
  supabaseUrl: "https://XXXX.supabase.co",
  // Supabase > Project Settings > API > Project API keys > anon / public
  supabaseAnonKey: "COLLE_ICI_LA_CLE_ANON",
  // Clé VAPID publique générée avec : npx web-push generate-vapid-keys
  vapidPublicKey: "COLLE_ICI_LA_CLE_VAPID_PUBLIQUE"
};
