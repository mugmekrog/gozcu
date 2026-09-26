/* Every word the interface says, in one table.
 *
 * The wireframes are in Turkish and so is the operator, so Turkish is the
 * product language, not a translation of an English original. Collecting the
 * copy here is not i18n scaffolding -- it is so that the vocabulary stays
 * consistent: the button that says "Değerlendir" produces a step list headed
 * "Değerlendir" and a log row that reads the same, which is how an operator
 * learns their way around.
 *
 * Keep these as an operator would say them: no system vocabulary ("bundle",
 * "hysteresis"), no apologies in errors, and an empty state that says what to do
 * next rather than that there is nothing.
 */

export const T = {
  app: {
    title: 'SENTINEL · ÜS RİSK AJANI',
    detector: 'dedektör: YOLO + RF-DETR',
    llmOn: 'LLM: bağlı',
    llmOff: 'LLM: kapalı (kural tabanlı)',
    llmBrief: 'LLM brief',
    loading: 'Tatbikat verisi yükleniyor…',
    loadFailed: 'Tatbikat verisi okunamadı.',
    loadFailedHint:
      'Fikstürler henüz üretilmemiş olabilir. Depo kökünde şunu çalıştırın: python web/scripts/export_fixtures.py',
    retry: 'Yeniden dene',
  },

  view: {
    kicker: 'BÖLGE HARİTASI /',
    map: 'HARİTA',
    motion: 'HAREKET',
    logs: 'KAYITLAR',
    menuTitle: 'GÖRÜNÜM',
    menuClose: 'Esc ✕',
    mapName: 'Harita',
    mapDesc: 'Bölgeler, drone kareleri ve araçlar radar üzerinde',
    motionName: 'Hareket',
    motionDesc: 'Üsse mesafe – zaman grafiği ve araç tablosu',
    logsName: 'Kayıtlar',
    logsDesc: 'Kareler, saha raporları, operatör kararları',
    openMenu: 'Görünüm menüsünü aç',
  },

  filter: {
    zone: 'ZONE',
    class: 'CLASS',
    all: 'Tümü',
    scale: 'ÖLÇEK',
    scaleUnit: 'km',
  },

  legend: {
    safe: 'Güvenli',
    review: 'İnceleme',
    threat: 'Yüksek tehdit',
    base: 'Merkez üs',
    zones: 'Bölgeler',
  },

  band: {
    critical: 'KRİTİK',
    high: 'YÜKSEK',
    review: 'İNCELEME',
    low: 'DÜŞÜK',
    unassessed: 'DEĞERLENDİRİLMEDİ',
    empty: 'ARAÇ YOK',
  },

  transport: {
    play: 'OYNAT',
    pause: 'DURAKLAT',
    clock: 'SAAT',
    speed: 'HIZ',
    scrub: 'Tatbikat saatini seç',
    frameMarker: 'kare',
  },

  vehicle: {
    class: 'SINIF',
    status: 'DURUM',
    distToBase: 'ÜSSE MESAFE',
    speed10: 'HIZ · son 10 dk',
    eta: 'ETA',
    stops: 'DURAKLAMA',
    selectFrame: 'Kareyi seç',
    toMotion: 'Hareket →',
    pin: '📌 Sabitle',
    unpin: 'Sabitlemeyi kaldır',
    approaching: 'üsse yaklaşıyor',
    receding: 'uzaklaşıyor',
    steady: 'sabit',
    stopped: 'duruyor',
    notSeen: 'karede görünmedi',
    pinned: '📌 SABİTLENMİŞ',
    pinNote: 'Kimlik rengi iz ve etiketi boyar · şekil riski gösterir',
    pinLimit: 'En fazla 6 araç sabitlenebilir.',
    convoy: 'KONVOY',
  },

  agent: {
    column: 'AGENT OUTPUTS',
    targetFrame: 'HEDEF KARE',
    frameCount: (n: number) => `${n} kare · tatbikat günü`,
    evaluate: '▶ Değerlendir',
    evaluateLocked: '▶ Değerlendir · kilitli',
    camera: '📷 Kamera',
    steps: 'AJAN ADIMLARI',
    stepsIdle: 'Kare seçip Değerlendir’e basın.',
    stepsRunning: (done: number, total: number, secs: string) =>
      `${done} / ${total} · ${secs} sn`,
    stepsDone: (total: number, tools: number, secs: string) =>
      `✓ ${total} / ${total} · ${tools} araç çağrısı · ${secs} sn`,
    stepsShow: 'göster ▾',
    stepsHide: 'gizle ▴',
    brief: 'BRIEF',
    briefIdle: 'Brief, değerlendirme tamamlanınca burada görünür.',
    briefPending: (done: number, total: number) =>
      `Brief hazırlanıyor · adım ${done}/${total} bekleniyor`,
    briefRules: 'kural tabanlı',
    briefLlm: (image: string) => `LLM · ${image}`,
    confidence: 'güven',
    confidenceLow: 'düşük',
    confidenceMid: 'orta',
    confidenceHigh: 'yüksek',
    findings: 'BULGULAR',
    reportReview: 'RAPOR DEĞERLENDİRMESİ',
    actions: 'ÖNERİLEN EYLEMLER',
    scoreBreakdown: 'SKOR DÖKÜMÜ',
    scoreBase: 'Temel',
    scoreAgent: 'LLM düzeltmesi',
    ask: 'AJANA SOR',
    askPlaceholder: 'Örn. T0029 neden iki kez durdu?',
    askSend: 'Gönder',
    askOffline:
      'Kopilot yalnızca LLM bağlıyken yanıt verir. Şu an kural tabanlı modda çalışılıyor.',
    noVehicles: 'Bu karede araç tespit edilmedi.',
    noVehiclesHint:
      'Adım 3’te 0 araç bulundu; hareket ve rapor adımları atlandı, risk skoru hesaplanmadı. Başka bir kare seçin ya da kamerayı açıp görüntüyü kontrol edin.',
    rulesOnlyNote:
      'Metin brief’i üretilmedi. Skor yalnızca kurallardan; LLM düzeltmesi uygulanmadı.',
  },

  step: {
    open: 'Görüntüyü aç',
    place: 'Haritaya yerleştir',
    detect: 'Araçları tespit et',
    georef: 'Pikseli koordinata çevir',
    findTracks: 'Hareket kaydını bul',
    toolCall: 'Araç çağrısı',
    kinematics: 'Hareketi çıkar',
    compareReports: 'Raporlarla karşılaştır',
    baseScore: 'Temel risk skoru',
    assess: 'Değerlendir',
    llmFailed: 'LLM erişilemedi → kural tabanlı brief’e düştüm',
    waiting: 'bekliyor',
    running: 'çalışıyor',
  },

  modal: {
    threatTitle: 'KRİTİK TEHDİT ALGILANDI',
    reviewTitle: 'İNSAN İNCELEMESİ GEREKMEKTE',
    close: 'Esc · kapat ✕',
    closeLabel: 'Uyarıyı kapat',
    rationale: 'GEREKÇE',
    uncertain: 'AJANIN EMİN OLAMADIĞI NOKTALAR',
    motionHistory: 'HAREKET GEÇMİŞİ · ÜSSE MESAFE',
    showDetail: 'ℹ Info / Detay Göster',
    hideDetail: '◀ Detayı gizle',
    notePlaceholder: 'Operatör notu (isteğe bağlı)…',
    noteLabel: 'Operatör notu',
    falseAlarm: 'Yanlış alarm',
    confirmThreat: 'Tehdidi onayla ve bildir',
    notThreat: 'Tehdit değil',
    markThreat: 'Tehdit olarak işaretle',
    target: 'HEDEF',
    confidenceLevel: 'CONFIDENCE LEVEL',
    threatLevel: 'THREAT LEVEL',
    assessment: 'DEĞERLENDİRME',
    boxLegendSafe: '□ mavi güvenli',
    boxLegendThreat: '□ kırmızı tehdit',
    cameraBeforeEval: 'kutular için Değerlendir',
    provenance: 'tespit: yolo · konum: köşe koordinatları',
    highConfidence: 'yüksek güven',
    midConfidence: 'orta güven',
    lowConfidence: 'düşük güven',
    threatDangerous: '▲ TEHLİKELİ',
    threatSuspect: '● ŞÜPHELİ',
    threatSafe: '■ GÜVENLİ',
    threatScale0: '0 güvenli',
    threatScale1: '1 şüpheli',
    threatScale2: '2 tehlikeli',
    imageMissing: 'Kare görüntüsü bulunamadı.',
    imageMissingHint:
      'Fikstürler --no-images ile üretilmiş. Kutular ve değerlendirme yine geçerlidir.',
  },

  motion: {
    chartTitle: 'ÜSSE MESAFE – ZAMAN',
    chartNote: (n: number) => `son 2 saat · tehdit + inceleme (${n} araç)`,
    showAll: 'tümünü göster',
    stopBand: 'duraklama',
    baseAxis: 'ÜS',
    empty: 'Bu saatte izlenen araç yok.',
    emptyHint: 'Zaman çizelgesini bir kareye taşıyın.',
    col: {
      track: 'İZ',
      class: 'SINIF',
      zone: 'ZONE',
      trend: 'EĞİLİM',
      base: 'ÜSSE',
      speed: 'HIZ',
      eta: 'ETA',
      stops: 'DURAK',
      score: 'PUAN',
    },
    trendApproaching: '↘ yaklaşıyor',
    trendReceding: '↗ uzaklaşıyor',
    trendSteady: '→ sabit',
    trendStopped: '— duruyor',
  },

  logs: {
    frames: 'KARELER',
    framesNote: (n: number) => `tatbikat günü · ${n} kare`,
    reports: 'SAHA RAPORLARI',
    reportsNote: (n: number) =>
      `${n} rapor · ajan her raporu kendi bulgularıyla karşılaştırır`,
    decisions: 'OPERATÖR KARARLARI GÜNLÜĞÜ',
    decisionsEmpty: 'Henüz operatör kararı kaydedilmedi.',
    col: {
      time: 'SAAT',
      frame: 'KARE',
      zone: 'ZONE',
      vehicles: 'ARAÇ',
      level: 'SEVİYE',
      alert: 'UYARI',
      decision: 'OPERATÖR KARARI',
      id: 'ID',
      source: 'KAYNAK',
      text: 'METİN',
      agentReview: 'AJANIN DEĞERLENDİRMESİ',
      agent: 'AJAN',
      note: 'NOT',
      operator: 'OPERATÖR',
    },
    noAlert: 'uyarı yok',
    alertThreat: 'kırmızı',
    alertReview: 'turuncu inceleme',
    pending: 'bekliyor',
    filterAll: 'tümü',
  },

  consistency: {
    agrees: 'tutarlı',
    contradicts: 'çelişiyor',
    unrelated: 'ilgisiz',
    unknown: 'değerlendirilmedi',
  },

  decision: {
    confirmed: 'Tehdit onaylandı ve bildirildi',
    false_alarm: 'Yanlış alarm',
    not_threat: 'Tehdit değil',
    marked_threat: 'Tehdit olarak işaretlendi',
    saved: '✓ Operatör kararı kaydedildi',
    goToLog: 'Kayda git',
    operator: 'nöbetçi-1',
  },

  cls: {
    car: 'otomobil',
    van: 'minibüs',
    truck: 'kamyon',
    bus: 'otobüs',
    unknown: 'bilinmiyor',
  },

  notSeen: {
    outside_footprint: 'kare dışında',
    no_detection_in_footprint: 'karede tespit edilmedi',
  },
} as const;

export function classLabel(cls: string | null | undefined): string {
  if (!cls) return T.cls.unknown;
  return (T.cls as Record<string, string>)[cls] ?? cls;
}

export function consistencyLabel(value: string | null | undefined): string {
  if (!value) return T.consistency.unknown;
  return (T.consistency as Record<string, string>)[value] ?? value;
}
