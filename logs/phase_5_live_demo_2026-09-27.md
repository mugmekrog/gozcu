# Faz 5 canlı demo geçişi — 2026-09-27

Branch: `dgkngk/phase_5_live`, `dgkngk/phase_5` (`41df5ec`) üzerinden ayrı worktree.

## Değişiklikler

- `goru.yaml`: GLM assessor ve JEV için `cache_only: false`. Aynı istek önbellekteyse kayıt kullanılmaya devam eder; kaçıran istek bütçe korumasıyla canlı sağlayıcıya gider.
- Yerel Vite geliştirme varsayılanı `http://127.0.0.1:8080` REST API. Compose zaten `VITE_API_BASE_URL` sağlıyor. Üretim derlemesinde URL verilmezse fixture adaptörü kalır.
- Fixture adaptörünün isteğe bağlı ajan servisi varsayılan portu 8080'e düzeltildi; README'ler güncellendi.

## Canlı doğrulama

- `img_000860` GLM assessor: model yanıtı, fallback yok, 8407 giriş + 1848 çıkış token, **$0.00911**. İlk sandbox denemesi bağlantı hatasıyla fallback olmuş ve $0 harcamıştı.
- Aynı görüntü için JEV: assessor önbellekten, JEV canlı çağrıdan; 6/6 araca güven skoru, fallback yok, 13631 giriş token.
- Bu doğrulama yalnızca tek görüntü için yapıldı; 40 görüntülük toplu tur çalıştırılmadı.
- REST dosyası hariç Python testleri: 238 geçti. Frontend tip denetimi ve fixture entegrasyon testleri: 6 geçti. İki Compose yapılandırması ve `git diff --check`: geçti.
