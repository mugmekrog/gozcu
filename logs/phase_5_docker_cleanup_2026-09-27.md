# Faz 5 değişiklik kaydı — 2026-09-27

Branch: `dgkngk/phase_5`, `origin/main` (`a5b2873`) üzerinden ayrı worktree.

## Değişiklikler

- Prod önizleme `npx` yerine imajın yerel Vite ikilisini çalıştırıyor; dev ve prod frontend healthcheck aldı.
- Dev API komutu `uvicorn --reload` kullanıyor; kaynak dizinleri mevcut bind mount'larla izleniyor.
- Track CSV sırası korunuyor, böylece gece yarısı geçişi `Timeline.advance_past` tarafından görülebiliyor. NaN/Infinity koordinatlar içeri alınmıyor.
- `DecisionModel` boş/yalnız boşluklu alanları, hedef türüyle uyuşmayan kararları, geçersiz seviyeyi ve 0–100 dışı ya da finite olmayan skorları doğruluyor.
- `.env` başlığı gerçek Git durumunu anlatıyor; `.env.example`, README ve PLAN Revision 4 anahtar rotasyonu gereğini, rapor/karar hattını, mevcut tehdit kontrollerini ve 188/217 exclusive eşleşme metriğini açıklıyor.

## Doğrulama

- REST dosyası hariç Python testleri: 238 geçti. `DecisionModel` hedefli REST testi: 1 geçti.
- `DecisionModel` için doğrudan geçerli/geçersiz model doğrulaması: geçti.
- Frontend `npm run typecheck`: geçti.
- İki Compose yapılandırması ve `git diff --check`: geçti.
- REST test dosyasındaki mevcut askıda kalma yüzünden o dosyanın tamamı doğrulanamadı; çalıştırma durduruldu.

## Dış bağımlılık / açık iş

`.env` Git geçmişinde gerçek GLM ve Typesafe anahtarları içeriyor. Bu değişiklik anahtarları döndüremez; servis sahipleri iki anahtarı sağlayıcılarında iptal edip yenilemeli **repo erişimi genişlemeden önce**. Geçmiş commit'ler de bu anahtarları taşımaya devam eder. Yeni anahtarlar Git'e eklenmemeli.
