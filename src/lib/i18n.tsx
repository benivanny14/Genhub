"use client";

import { createContext, useContext, useState, useEffect, ReactNode } from "react";

type Locale = "en" | "sw";

interface I18nContextType {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const translations: Record<string, Record<Locale, string>> = {
  // Nav
  "nav.search": { en: "Search videos...", sw: "Tafuta video..." },
  "nav.upload": { en: "Upload", sw: "Pakia" },
  "nav.wallet": { en: "Wallet", sw: "Pochi" },
  "nav.favorites": { en: "Saved", sw: "Zilizohifadhiwa" },
  "nav.signIn": { en: "Sign In", sw: "Ingia" },
  "nav.getStarted": { en: "Get Started", sw: "Anza" },
  "nav.signOut": { en: "Sign Out", sw: "Ondoka" },
  "nav.myProfile": { en: "My Profile", sw: "Wasifu Wangu" },
  "nav.dashboard": { en: "Dashboard", sw: "Dashibodi" },
  "nav.admin": { en: "Admin Panel", sw: "Paneli ya Admin" },

  // Home
  "home.heroTitle": { en: "Premium Video Streaming", sw: "Video ya Kulipia" },
  "home.heroDesc": {
    en: "The platform for East African creators to share, earn, and thrive.\nUpload content, earn revenue, and enjoy quality entertainment.",
    sw: "Jukwaa la video kwa waumbaji wa Afrika Mashariki.\nPakia, jichukulie mapato, na ufurahie maudhui ya ubora.",
  },
  "home.searchPlaceholder": { en: "Search videos, creators, or content...", sw: "Tafuta video, waumbaji, au maudhui..." },
  "home.search": { en: "Search", sw: "Tafuta" },
  "home.noVideos": { en: "No videos yet", sw: "Hakuna video bado" },
  "home.beFirst": { en: "Be the first to share your content!", sw: "Kuwa wa kwanza kujichukulia!" },
  "home.previous": { en: "Previous", sw: "Nyuma" },
  "home.next": { en: "Next", sw: "Mbele" },
  "home.pageOf": { en: "Page {p} of {t}", sw: "Ukurasa {p} kati ya {t}" },
  "cat.all": { en: "All", sw: "Vyote" },
  "sort.newest": { en: "Newest", sw: "Mpya" },
  "sort.popular": { en: "Popular", sw: "Maarufu" },
  "sort.rated": { en: "Top Rated", sw: "Zilizopendwa zaidi" },
  "sort.priceLow": { en: "Price: Low", sw: "Bei Ndogo" },
  "sort.priceHigh": { en: "Price: High", sw: "Bei Kubwa" },
  "sort.trending": { en: "🔥 Trending", sw: "🔥 Inayovuma" },

  // Auth
  "auth.welcomeBack": { en: "Welcome to Genhub", sw: "Karibu Genhub" },
  "auth.signInDesc": { en: "Sign in to enjoy premium content", sw: "Ingia ili kufurahia maudhui ya ubora" },
  "auth.phone": { en: "Phone", sw: "Simu" },
  "auth.email": { en: "Email", sw: "Barua Pepe" },
  "auth.password": { en: "Password", sw: "Nenosiri" },
  "auth.signIn": { en: "Sign In", sw: "Ingia" },
  "auth.signingIn": { en: "Signing in...", sw: "Inaingia..." },
  "auth.forgotPassword": { en: "Forgot password?", sw: "Sahau nenosiri?" },
  "auth.noAccount": { en: "Don't have an account?", sw: "Hauna akaunti?" },
  "auth.signUpNow": { en: "Sign up now", sw: "Jisajili sasa" },
  "auth.joinGenhub": { en: "Join Genhub", sw: "Jiunge na Genhub" },
  "auth.signUpDesc": { en: "Start your streaming journey today", sw: "Anza safari yako ya video" },
  "auth.viewer": { en: "Viewer", sw: "Mtazamaji" },
  "auth.viewerDesc": { en: "Watch videos", sw: "Tazama video" },
  "auth.creator": { en: "Creator", sw: "Muundaji" },
  "auth.creatorDesc": { en: "Upload videos", sw: "Pakia video" },
  "auth.displayName": { en: "Display Name", sw: "Jina la Kuonyesha" },
  "auth.emailOptional": { en: "Email (optional)", sw: "Barua pepe (hiari)" },
  "auth.phoneOptional": { en: "Phone number (optional)", sw: "Nambari ya simu (hiari)" },
  "auth.bothHint": { en: "Enter email OR phone number (or both)", sw: "Weka barua pepe AU nambari ya simu (au zote mbili)" },
  "auth.passwordPlaceholder": { en: "Password (8+ characters)", sw: "Nenosiri (herufi 8+)" },
  "auth.confirmPassword": { en: "Confirm password", sw: "Rudia nenosiri" },
  "auth.creating": { en: "Creating account...", sw: "Inasajili..." },
  "auth.createAccount": { en: "Create Account", sw: "Jisajili" },
  "auth.kycWarning": { en: "⚠️ As a creator, you'll need to complete KYC verification before uploading videos.", sw: "⚠️ Kama mwambaaji, utahitaji kupitisha KYC kabla ya kupakia video." },
  "auth.hasAccount": { en: "Already have an account?", sw: "Tayari una akaunti?" },
  "auth.signInHere": { en: "Sign in here", sw: "Ingia hapa" },
  "auth.networkError": { en: "Network error. Please try again.", sw: "Hitilafu ya mtandao. Jaribu tena." },

  // Video
  "video.back": { en: "Back", sw: "Rudi" },
  "video.views": { en: "{n} views", sw: "{n} maoni" },
  "video.creator": { en: "Creator", sw: "Muundaji" },
  "video.buy": { en: "Buy — {p}", sw: "Nunua — {p}" },
  "video.signInToBuy": { en: "Sign in to Buy", sw: "Ingia ili Kununua" },
  "video.purchased": { en: "✓ Purchased", sw: "✓ Umenunua" },
  "video.description": { en: "Description", sw: "Maelezo" },
  "video.like": { en: "Like", sw: "Penda" },
  "video.messages": { en: "Messages", sw: "Jumbe" },
  "video.share": { en: "Share", sw: "Shiriki" },
  "video.report": { en: "Report", sw: "Ripoti" },
  "video.notFound": { en: "Video not found", sw: "Video haipatikani" },
  "video.goHome": { en: "Go home", sw: "Rudi nyumbani" },
  "video.buyTitle": { en: "Buy Video", sw: "Nunua Video" },
  "video.buyDesc": { en: "Choose your payment method and enter your details.", sw: "Chagua njia ya malipo na ujaze taarifa zako." },
  "video.payMethod": { en: "Payment Method", sw: "Njia ya Malipo" },
  "video.phone": { en: "Phone Number", sw: "Nambari ya Simu" },
  "video.price": { en: "Video price", sw: "Bei ya video" },
  "video.cancel": { en: "Cancel", sw: "Ghairi" },
  "video.payNow": { en: "Pay Now", sw: "Lipa Sasa" },
  "video.processing": { en: "Processing...", sw: "Inachakata..." },
  "video.noSaved": { en: "No saved videos", sw: "Hakuna video zilizohifadhiwa" },
  "video.tapHeart": { en: "Tap the heart icon on any video to save it here.", sw: "Bofya alama ya moyo kwenye video kuzihifadhi hapa." },
  "video.savedVideos": { en: "Saved Videos", sw: "Video Zangu Zilizohifadhiwa" },

  // Wallet
  "wallet.balance": { en: "Wallet Balance", sw: "Salio la Pochi" },
  "wallet.addFunds": { en: "Add Funds", sw: "Ongeza Pesa" },
  "wallet.history": { en: "Transaction History", sw: "Historia ya Miamala" },
  "wallet.noTransactions": { en: "No transactions yet", sw: "Bado hakuna miamala" },
  "wallet.topUp": { en: "Wallet Top-up", sw: "Kuongeza Salio" },
  "wallet.amount": { en: "Amount", sw: "Kiasi" },
  "wallet.payMethod": { en: "Payment Method", sw: "Njia ya Malipo" },
  "wallet.phone": { en: "Phone number", sw: "Nambari ya simu" },
  "wallet.customAmount": { en: "Custom amount...", sw: "Kiasi kingine..." },
  "wallet.pay": { en: "Pay {p}", sw: "Lipa {p}" },
  "wallet.completed": { en: "Completed", sw: "Imekamilika" },
  "wallet.pending": { en: "Pending", sw: "Inasubiri" },
  "wallet.failed": { en: "Failed", sw: "Imeshindikana" },

  // Creator
  "creator.title": { en: "Creator Dashboard", sw: "Dashibodi ya Muundaji" },
  "creator.desc": { en: "Track your earnings and video performance", sw: "Fuatilia mapato na video zako" },
  "creator.completeKyc": { en: "Complete KYC", sw: "Pitisha KYC" },
  "creator.uploadVideo": { en: "Upload Video", sw: "Pakia Video" },
  "creator.kycNotVerified": { en: "KYC not yet verified", sw: "KYC haijathibitishwa bado" },
  "creator.kycDesc": { en: "You must complete KYC verification before uploading videos or requesting payouts.", sw: "Lazima upitilizwe KYC kabla ya kupakia video au kutoa pesa." },
  "creator.submitNow": { en: "Submit now", sw: "Wasilisha sasa" },
  "creator.totalEarnings": { en: "Total Earnings", sw: "Jumla ya Mapato" },
  "creator.available": { en: "Available Balance", sw: "Salio Linalopatikana" },
  "creator.pending": { en: "Pending (14 days)", sw: "Kwenye Kukomaa (14 siku)" },
  "creator.todays": { en: "Today's Earnings", sw: "Mapato ya Leo" },
  "creator.totalViews": { en: "Total Views", sw: "Jumla ya Maoni" },
  "creator.videos": { en: "Videos", sw: "Video" },
  "creator.purchases": { en: "Purchases", sw: "Ununuzi" },
  "creator.yourShare": { en: "Your Revenue Share", sw: "Kiwango chako" },
  "creator.requestPayout": { en: "Request Payout", sw: "Omba Kutoa Pesa" },
  "creator.minPayout": { en: "(Min: TZS 30,000 + KYC required)", sw: "(Kiungo: TZS 30,000+, KYC inahitajika)" },
  "creator.videoPerf": { en: "Video Performance", sw: "Utendaji wa Video" },
  "creator.noVideos": { en: "No videos yet", sw: "Bado hakuna video" },
  "creator.recentTx": { en: "Recent Transactions", sw: "Miamala ya Hivi Karibuni" },
  "creator.requestPayoutTitle": { en: "Request Payout", sw: "Omba Kutoa Pesa" },
  "creator.availBalance": { en: "Available balance: {p}", sw: "Salio linalopatikana: {p}" },
  "creator.amount": { en: "Amount (TZS)", sw: "Kiasi (TZS)" },
  "creator.payMethod": { en: "Payment Method", sw: "Njia ya Malipo" },
  "creator.accountDetails": { en: "Account Details", sw: "Taarifa za Akaunti" },
  "creator.submitting": { en: "Submitting...", sw: "Inatuma..." },
  "creator.submitRequest": { en: "Submit Request", sw: "Tuma Ombi" },

  // KYC
  "kyc.title": { en: "Identity Verification (KYC)", sw: "Uthibitishaji wa Kitambulisho (KYC)" },
  "kyc.desc": { en: "Complete verification to start earning and uploading content.", sw: "Ingia pesa na kupakia video, lazima uthibitishwe kwanza." },
  "kyc.verified": { en: "KYC Verified!", sw: "KYC Imethibitishwa!" },
  "kyc.verifiedDesc": { en: "Your profile has been verified. You can now upload videos and request payouts.", sw: "Wasifu wako umethibitishwa. Unaweza sasa kupakia video na kutoa pesa." },
  "kyc.backDash": { en: "Back to Dashboard", sw: "Rudi Dashibodini" },
  "kyc.underReview": { en: "KYC Under Review", sw: "KYC Inashughulikiwa" },
  "kyc.reviewDesc": { en: "Your application is being reviewed. Please wait a moment.", sw: "Ombi lako linashughulikiwa. Subiri muda mfupi." },
  "kyc.rejected": { en: "KYC Rejected", sw: "KYC Imekataliwa" },
  "kyc.resubmit": { en: "Please resubmit with correct information.", sw: "Tafadhali wasilisha tena na taarifa sahihi." },
  "kyc.submitForm": { en: "Submit KYC", sw: "Wasilisha KYC" },
  "kyc.instructions": { en: "Instructions:", sw: "Maelekezo:" },
  "kyc.step1": { en: "Take a photo of your government ID (NIDA/Passport)", sw: "Piga picha ya kitambulisho chako (NIDA/Passport)" },
  "kyc.step2": { en: "Take a selfie holding a card / paper with:", sw: "Piga selfie ukishikile kadi / karatasi yenye:" },
  "kyc.step3": { en: '"Genhub + today\'s date" handwritten', sw: '"Genhub + tarehe ya leo" kwa mkono' },
  "kyc.step4": { en: "Paste the image URLs below", sw: "Andika URL za picha hapa chini" },
  "kyc.idType": { en: "ID Type", sw: "Aina ya Kitambulisho" },
  "kyc.idUrl": { en: "ID Document Image URL", sw: "URL ya Picha ya Kitambulisho" },
  "kyc.selfieUrl": { en: "Selfie URL", sw: "URL ya Selfie" },
  "kyc.submitting": { en: "Submitting...", sw: "Inatuma..." },
  "kyc.submit": { en: "Submit KYC", sw: "Wasilisha KYC" },

  // Upload
  "upload.title": { en: "Upload Video", sw: "Pakia Video" },
  "upload.desc": { en: "Select a video and fill in the details", sw: "Chagua video na ujaze taarifa" },
  "upload.selectVideo": { en: "Select Video", sw: "Chagua Video" },
  "upload.clickHere": { en: "Click here to upload your video", sw: "Bofya hapa kupakia video yako" },
  "upload.formats": { en: "MP4, MOV, AVI — Max 2GB", sw: "MP4, MOV, AVI — Max 2GB" },
  "upload.uploading": { en: "Uploading... {p}%", sw: "Inapakia... {p}%" },
  "upload.uploaded": { en: "Video uploaded successfully!", sw: "Video imepakiwa kikamilifu!" },
  "upload.videoTitle": { en: "Video Title", sw: "Kichwa cha Video" },
  "upload.descLabel": { en: "Description", sw: "Maelezo" },
  "upload.price": { en: "Price (TZS)", sw: "Bei (TZS)" },
  "upload.preview": { en: "Preview (seconds)", sw: "Preview (sekunde)" },
  "upload.previewRange": { en: "15-30 seconds", sw: "15-30 sekunde" },
  "upload.category": { en: "Category", sw: "Jamii" },
  "upload.selectCat": { en: "Select category...", sw: "Chagua jamii..." },
  "upload.tags": { en: "Tags (comma separated)", sw: "Viheshinio (kwa koma)" },
  "upload.thumbnailUrl": { en: "Thumbnail URL", sw: "URL ya Picha ya Kifungo" },
  "upload.creating": { en: "Creating...", sw: "Inaundwa..." },
  "upload.createVideo": { en: "Create Video", sw: "Unda Video" },
  "upload.successTitle": { en: "Video Uploaded!", sw: "Video Imepakiwa!" },
  "upload.successDesc": { en: "Your video has been created and is being processed.", sw: "Video yako imeundwa na inashughulikiwa." },
  "upload.another": { en: "Upload Another Video", sw: "Pakia Video Nyingine" },

  // Admin
  "admin.title": { en: "Admin Panel", sw: "Admin Panel" },
  "admin.desc": { en: "Genhub platform management", sw: "Usimamizi wa jukwaa la Genhub" },
  "admin.overview": { en: "Overview", sw: "Muhtasari" },
  "admin.kyc": { en: "KYC", sw: "KYC" },
  "admin.reports": { en: "Reports", sw: "Ripoti" },
  "admin.payouts": { en: "Payouts", sw: "Malipo" },
  "admin.totalUsers": { en: "Total Users", sw: "Watumiaji Wote" },
  "admin.platformRevenue": { en: "Platform Revenue (30%)", sw: "Mapato ya Jukwaa (30%)" },
  "admin.pendingKyc": { en: "Pending KYC", sw: "KYC Zinazosubiri" },
  "admin.newReports": { en: "New Reports", sw: "Ripoti Mpya" },
  "admin.kycQueue": { en: "KYC Queue", sw: "Orodha ya KYC" },
  "admin.noPendingKyc": { en: "No pending KYC submissions", sw: "Hakuna KYC mpya kusubiri" },
  "admin.videoReports": { en: "Video Reports", sw: "Ripoti za Video" },
  "admin.noReports": { en: "No new reports", sw: "Hakuna ripoti mpya" },
  "admin.payoutRequests": { en: "Payout Requests", sw: "Ombi za Kutoa Pesa" },
  "admin.noPayouts": { en: "No pending payout requests", sw: "Hakuna ombi la kutoa pesa" },
  "admin.approve": { en: "Approve", sw: "Kubali" },
  "admin.reject": { en: "Reject", sw: "Kataa" },
  "admin.hideVideo": { en: "Hide Video", sw: "Ficha Video" },
  "admin.freezeEarnings": { en: "Freeze Earnings", sw: "Funga Mapato" },
  "admin.warning": { en: "Warning", sw: "Onyo" },
  "admin.ban": { en: "Ban", sw: "Funga" },
  "admin.dismiss": { en: "Dismiss", sw: "Acha" },
  "admin.markPaid": { en: "Mark Paid", sw: "Imelipwa" },

  // Profile
  "profile.title": { en: "My Profile", sw: "Wasifu Wangu" },
  "profile.personal": { en: "Personal Information", sw: "Taarifa Binafsi" },
  "profile.displayName": { en: "Display Name", sw: "Jina la Kuonyesha" },
  "profile.language": { en: "Language", sw: "Lugha" },
  "profile.saving": { en: "Saving...", sw: "Inahifadhi..." },
  "profile.saveChanges": { en: "Save Changes", sw: "Hifadhi Mabadiliko" },
  "profile.changePassword": { en: "Change Password", sw: "Badilisha Nenosiri" },
  "profile.currentPw": { en: "Current Password", sw: "Nenosiri la Sasa" },
  "profile.newPw": { en: "New Password", sw: "Nenosiri Jipya" },
  "profile.confirmPw": { en: "Confirm New Password", sw: "Rudia Nenosiri Jipya" },

  // Forgot Password
  "forgot.title": { en: "Forgot Password?", sw: "Sahau Nenosiri?" },
  "forgot.desc": { en: "We'll send you a recovery code", sw: "Tutakutumia nambari ya kurejesha nenosiri lako" },
  "forgot.sent": { en: "Message Sent!", sw: "Ujumbe Umetumwa!" },
  "forgot.sentDesc": { en: "Please check your phone or email for the recovery code.", sw: "Tafadhali angalia simu au barua pepe yako kwa nambari ya kurejesha nenosiri." },
  "forgot.backToSignIn": { en: "Back to Sign In", sw: "Rudi Kwenye Kuingia" },
  "forgot.sendCode": { en: "Send Recovery Code", sw: "Tuma Nambari ya Kurejesha" },
  "forgot.sending": { en: "Sending...", sw: "Inatuma..." },

  // Reset Password
  "reset.title": { en: "Set New Password", sw: "Weka Nenosiri Jipya" },
  "reset.invalidToken": { en: "Invalid Token", sw: "Token haipo" },
  "reset.invalidTokenDesc": { en: "The password reset link is invalid", sw: "Nambari ya kurejesha nenosiri si sahihi" },
  "reset.requestAgain": { en: "Request Again", sw: "Omba Tena" },
  "reset.changed": { en: "Password Changed!", sw: "Nenosiri Limebadilishwa!" },
  "reset.changedDesc": { en: "You can now sign in with your new password.", sw: "Unaweza sasa kuingia na nenosiri jipya." },
  "reset.signInNow": { en: "Sign In Now", sw: "Ingia Sasa" },
  "reset.newPw": { en: "New password (8+ characters)", sw: "Nenosiri jipya (herufi 8+)" },
  "reset.confirmPw": { en: "Confirm new password", sw: "Rudia nenosiri jipya" },
  "reset.saving": { en: "Saving...", sw: "Kuweka..." },
  "reset.setNew": { en: "Set New Password", sw: "Weka Nenosiri Jipya" },

  // Error / 404
  "error.title": { en: "Something Went Wrong", sw: "Hitilafu Imetokea" },
  "error.desc": { en: "An unexpected error has occurred.", sw: "Kuna hitilafu isiyotarajiwa imetokea." },
  "error.tryAgain": { en: "Try Again", sw: "Jaribu Tena" },
  "error.home": { en: "Home", sw: "Nyumbani" },
  "notfound.title": { en: "Page Not Found", sw: "Ukurasa hauipo" },
  "notfound.desc": { en: "The page you are looking for does not exist or has been removed.", sw: "Ukurasa unatafuta haujaundwa au umeondolewa." },
  "notfound.goBack": { en: "Go Back", sw: "Rudi Nyuma" },

  // Creator Profile
  "creatorProfile.subscribers": { en: "{n} subscribers", sw: "{n} wafuataji" },
  "creatorProfile.videosBy": { en: "Videos by {n}", sw: "Video za {n}" },
  "creatorProfile.noVideos": { en: "No videos yet", sw: "Bado hakuna video" },
  "creatorProfile.notFound": { en: "Creator not found", sw: "Muundaji huyu haupo" },
  "creatorProfile.subscribe": { en: "Subscribe — TZS {p}/month", sw: "Jisajili — TZS {p}/mwezi" },
  "creatorProfile.subscribing": { en: "Subscribing...", sw: "Inasajili..." },
  "creatorProfile.subscribed": { en: "✓ Subscribed", sw: "✓ Umefuata" },

  // Common
  "common.loading": { en: "Loading...", sw: "Inapakia..." },
  "common.error": { en: "An error occurred", sw: "Hitilafu imetokea" },
  "common.networkError": { en: "Network error", sw: "Hitilafu ya mtandao" },
  "common.cancel": { en: "Cancel", sw: "Ghairi" },
  "common.submit": { en: "Submit", sw: "Wasilisha" },
};

const I18nContext = createContext<I18nContextType>({
  locale: "en",
  setLocale: () => {},
  t: (key: string) => key,
});

export function useI18n() {
  return useContext(I18nContext);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem("genhub-locale") as Locale | null;
    if (saved && (saved === "en" || saved === "sw")) {
      setLocaleState(saved);
    }
  }, []);

  function setLocale(l: Locale) {
    setLocaleState(l);
    if (mounted) {
      localStorage.setItem("genhub-locale", l);
    }
  }

  function t(key: string, params?: Record<string, string | number>): string {
    const entry = translations[key];
    if (!entry) return key;
    let text = entry[locale] || entry.en || key;
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      });
    }
    return text;
  }

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}
