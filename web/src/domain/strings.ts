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
    title: 'GÖZCÜ · BÖLGE İZLEME',
    mobileNotify: 'Mobil bildirim',
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
    menuHint: 'Haritayı nasıl incelediğinizi seçin',
    menuClose: 'Esc ✕',
    menuEsc: 'kapat',
    mapName: 'Harita',
    mapDesc: 'Bölgeler, drone kareleri ve araçlar radar üzerinde',
    motionName: 'Hareket',
    motionDesc: 'Üsse mesafe – zaman grafiği ve araç tablosu',
    logsName: 'Kayıtlar',
    logsDesc: 'Kareler, saha raporları, operatör kararları',
    voice: 'SESLE KONTROL',
    voiceName: 'Sesle kontrol',
    voiceDesc: 'Türkçe sesli komut, duyulanlar ve yapılanlar',
    openMenu: 'Görünüm menüsünü aç',
  },

  filter: {
    zone: 'Bölge',
    class: 'Araç türü',
    all: 'Tümü',
    scale: 'ÖLÇEK',
    scaleUnit: 'km',
  },

  legend: {
    safe: 'Güvenli',
    review: 'Şüpheli',
    threat: 'Tehlike',
    base: 'Merkez üs',
    zones: 'Bölgeler',
  },

  band: {
    critical: 'TEHLİKE',
    high: 'TEHLİKE',
    review: 'ŞÜPHELİ',
    low: 'GÜVENLİ',
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
    eta: 'Varış süresi',
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
    pinNote: 'İz ve etiket sabitleme rengini kullanır · araç şekli türünü gösterir',
    pinLimit: 'En fazla 6 araç sabitlenebilir.',
    convoy: 'KONVOY',
  },

  crop: {
    title: 'HEDEF GÖRÜNTÜ',
    enlarge: '⤢ Görseli büyüt',
    fullFrame: 'Tüm kare',
    target: 'Hedef',
    close: 'Kapat ✕',
    loading: 'Kare yükleniyor…',
    notCaptured: 'Araç henüz bir drone karesinde görüntülenmedi.',
    noFrame: 'Bu araç hiçbir drone karesinde yok.',
    noMatch: 'Karede bu araca eşleşen tespit yok.',
    matchLow: 'düşük güvenli eşleşme',
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
    showDetail: 'ℹ Ayrıntıyı göster',
    hideDetail: '◀ Detayı gizle',
    notePlaceholder: 'Operatör notu (isteğe bağlı)…',
    noteLabel: 'Operatör notu',
    falseAlarm: 'Yanlış alarm',
    confirmThreat: 'Tehdidi onayla ve bildir',
    notThreat: 'Tehdit değil',
    markThreat: 'Tehdit olarak işaretle',
    target: 'HEDEF',
    confidenceLevel: 'GÜVEN DÜZEYİ',
    threatLevel: 'TEHLİKE DÜZEYİ',
    assessment: 'UYARI GEREKÇESİ',
    boxLegendSafe: '□ mavi güvenli',
    boxLegendSuspect: '□ sarı şüpheli',
    boxLegendThreat: '□ kırmızı tehlike',
    cameraBeforeEval: 'GPS konumları ve tespit kutuları',
    provenance: 'tespit: görüntü kutuları · konum: köşe koordinatları',
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
      zone: 'BÖLGE',
      trend: 'EĞİLİM',
      base: 'ÜSSE',
      speed: 'HIZ',
      eta: 'VARIŞ',
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
    reportsNote: (n: number) => `${n} rapor · iz ve tespitlerle karşılaştırıldı`,
    decisions: 'OPERATÖR KARARLARI GÜNLÜĞÜ',
    decisionsEmpty: 'Henüz operatör kararı kaydedilmedi.',
    col: {
      time: 'SAAT',
      frame: 'KARE',
      zone: 'BÖLGE',
      vehicles: 'ARAÇ',
      level: 'SEVİYE',
      alert: 'UYARI',
      decision: 'OPERATÖR KARARI',
      id: 'ID',
      source: 'KAYNAK',
      text: 'METİN',
      agentReview: 'TUTARLILIK',
      agent: 'UYARI DÜZEYİ',
      note: 'NOT',
      operator: 'OPERATÖR',
    },
    noAlert: 'uyarı yok',
    alertThreat: 'kırmızı',
    alertReview: 'sarı inceleme',
    pending: 'bekliyor',
    filterAll: 'tümü',
    tabs: { frames: 'Kareler', reports: 'Saha raporları', decisions: 'Kararlar' },
    tabsLabel: 'Kayıt türü',
    upToClock: (hhmm: string) => `${hhmm} itibarıyla`,
    levelFilter: 'Seviye filtresi',
    verdictFilter: 'Doğrulama filtresi',
    sourceFilter: 'Kaynak filtresi',
    verdict: {
      all: 'Tümü',
      contradicts: 'Çelişen',
      agrees: 'Uyumlu',
      unrelated: 'İlgisiz',
      unchecked: 'Kontrol edilmedi',
    },
    source: { all: 'Tüm kaynaklar', official: 'Resmî', third_party: 'Üçüncü taraf' },
    level: { all: 'Tümü', threat: 'Tehlike', review: 'Şüpheli', safe: 'Güvenli' },
    checkedIn: 'ile karşılaştırıldı',
    uncheckedNote: 'Hiçbir karenin görüş alanına ve zaman penceresine düşmedi.',
    noMatch: 'Bu filtreye uyan kayıt yok.',
    decided: (n: number, total: number) => `${n} / ${total} kare kararlandı`,
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

  /* Sesle kontrol. Every line an operator can be shown about speech.
   *
   * Written as an operator would say it back: the confirmations are in the past
   * tense because by the time one is read the thing has happened, and the
   * refusals name what to do instead of apologising. The failure lines matter
   * more than the successes -- a command that worked is visible on the map, and a
   * command that did not is only visible here. */
  voice: {
    panel: 'SESLE KONTROL',
    hint: 'Mikrofona basın, Türkçe komutu söyleyin.',
    hintKey: 'V',
    start: '🎙 Dinle',
    stop: '■ Bitir',
    cancel: 'Vazgeç',
    idle: 'hazır',
    calibrating: 'ortam ölçülüyor…',
    listening: 'dinliyor…',
    hearing: 'duyuyorum',
    trailing: 'bitmesini bekliyorum…',
    transcribing: 'çözümleniyor…',
    routing: 'komut anlaşılıyor…',
    working: 'uygulanıyor…',
    level: 'SES DÜZEYİ',
    levelQuiet: 'ses çok düşük · mikrofona yaklaşın',
    clipping: 'ses kırpılıyor · mikrofondan uzaklaşın',
    heldSeconds: (s: string) => `${s} sn`,
    remaining: (s: string) => `kalan ${s} sn`,

    history: 'DUYULANLAR',
    historyEmpty: 'Henüz sesli komut verilmedi.',
    historyHint: 'Mikrofona basıp "kayıtlar sayfasına geç" deyin.',
    heard: 'duyulan',
    understood: 'anlaşılan',
    modelSaid: 'model şunu yazdı',
    normalised: 'düzeltilen',
    commandLabel: 'komut',
    cached: 'önbellekten · ücretsiz',
    latency: (ms: number) => `${ms} ms`,

    examples: 'ÖRNEK KOMUTLAR',
    examplesNote: 'Sesle yapılabilecek her şey burada listelidir.',
    effectView: 'görünüm',
    effectCompute: 'işlem',
    effectAudit: 'kayda geçer',

    confirmTitle: 'SESLİ KARAR ONAYI',
    confirmBody: (what: string) => `"${what}" kaydedilecek. Bu karar kayda geçer ve geri alınamaz.`,
    confirmHeard: 'duyulan komut',
    confirmYes: 'Evet, kaydet',
    confirmNo: 'Vazgeç',
    confirmTimeout: 'Onay verilmedi; karar kaydedilmedi.',
    adminNote:
      'Ses yönetici seviyesindedir: kayıttaki her komutu çalıştırabilir. Karar kaydeden komutlar için onay istenir.',

    // --- what happened ---------------------------------------------------- //
    didView: (name: string) => `${name} görünümüne geçildi`,
    didFrame: (id: string) => `${id} karesi seçildi`,
    didAssess: (id: string) => `${id} değerlendirmesi başlatıldı`,
    didSelect: (id: string) => `${id} seçildi`,
    didPin: (id: string, pinned: boolean) =>
      pinned ? `${id} sabitlendi` : `${id} sabitlemesi kaldırıldı`,
    pinAlready: (id: string, pinned: boolean) =>
      pinned ? `${id} zaten sabitli` : `${id} zaten sabitli değil`,
    didClock: (hhmm: string) => `saat ${hhmm} yapıldı`,
    didPlay: 'oynatılıyor',
    didPause: 'duraklatıldı',
    didSpeed: (speed: number) => `hız ${speed}×`,
    didZone: (zone: string) => `bölge filtresi: ${zone}`,
    didClass: (cls: string) => `sınıf filtresi: ${cls}`,
    didScale: (km: number) => `ölçek ${km} km`,
    didCameraOpen: 'kamera açıldı',
    didCameraClose: 'kamera kapatıldı',
    didDismiss: 'uyarı kapatıldı',
    didDecision: (verdict: string) => `karar kaydedildi: ${verdict}`,
    didAsk: 'kopilota soruldu',
    noteBySpeech: 'sesle verildi',

    // --- why it did not --------------------------------------------------- //
    needFrame: 'Önce bir kare seçin.',
    needTrack: 'Hangi araç olduğunu anlayamadım.',
    needQuestion: 'Soruyu anlayamadım.',
    needFilter: 'Hangi filtreyi değiştireceğimi anlayamadım.',
    needPlayback: 'Oynat, duraklat ya da bir hız söyleyin.',
    noSuchFrame: (id: string) => `${id} diye bir kare yok.`,
    noSuchTrack: (id: string) => `${id} diye bir araç yok.`,
    noSuchZone: (zone: string) => `${zone} diye bir bölge yok.`,
    noSuchClass: (cls: string) => `${cls} diye bir sınıf yok.`,
    noModal: 'Kapatılacak bir uyarı yok.',
    badView: (view: string) => `${view || 'Bu'} diye bir görünüm yok.`,
    badClock: (hhmm: string) => `${hhmm || 'Bu'} bir saat değil.`,
    badSpeed: (speed: number) => `${speed}× bir hız seçeneği değil.`,
    badScale: (km: number) => `${km} km bir ölçek seçeneği değil.`,
    badVerdict: (verdict: string) => `${verdict || 'Bu'} bir karar değil.`,
    unknownCommand: (name: string) => `${name} komutu bu ekranda yok.`,

    // --- speech itself is unavailable ------------------------------------- //
    unavailable: 'Sesli kontrol şu an kullanılamıyor.',
    offline:
      'Konuşma servisi çalışmıyor. Depo kökünde başlatın: python services/api/app/cli.py serve-stt',
    err: {
      STT_DISABLED: 'Sesli kontrol goru.yaml içinde kapalı.',
      STT_UNAVAILABLE: 'Konuşma servisine ulaşılamıyor.',
      CUDA_UNAVAILABLE: 'GPU bulunamadı; konuşma modeli çalıştırılamıyor.',
      GPU_OUT_OF_MEMORY: 'GPU belleği yetmedi. compute_type: int8_float16 deneyin.',
      MODEL_UNAVAILABLE: 'Konuşma modeli yüklenemedi.',
      AUDIO_INVALID: 'Ses kaydı okunamadı.',
      AUDIO_TOO_LONG: 'Komut çok uzun. Daha kısa söyleyin.',
      AUDIO_TOO_SHORT: 'Çok kısa sürdü; komut duyulmadı.',
      NO_SPEECH: 'Konuşma duyulmadı, yalnızca ortam gürültüsü.',
      EMPTY_TRANSCRIPT: 'Söylenen çözümlenemedi. Tekrar söyleyin.',
      WORKER_CRASHED: 'Konuşma işlemi beklenmedik şekilde durdu.',
      ROUTER_UNAVAILABLE:
        'Komut yönlendirici erişilemiyor. Duyulan metin aşağıda; işlemi elle yapabilirsiniz.',
      VOICE_DISABLED: 'Sesli komut goru.yaml içinde kapalı.',
      NO_MICROPHONE: 'Mikrofon bulunamadı.',
      PERMISSION_DENIED: 'Mikrofon izni verilmedi. Adres çubuğundaki izinleri açın.',
      DEVICE_BUSY: 'Mikrofon başka bir uygulamada kullanılıyor.',
      UNSUPPORTED: 'Bu tarayıcı mikrofon yakalamayı desteklemiyor.',
      CAPTURE_FAILED: 'Mikrofon açılamadı.',
      TOO_SHORT: 'Çok kısa sürdü; komut duyulmadı.',
      NO_SPEECH_HEARD: 'Hiç konuşma duyulmadı.',
      CANCELLED: 'Vazgeçildi.',
    } as Record<string, string>,
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
