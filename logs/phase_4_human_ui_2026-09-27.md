# Faz 4 — insan kararı ve arayüz

Çalışma dalı: `dgkngk/phase_4`; ayrı worktree: `/tmp/suyla-phase-4`. Başlangıç: `b496194`. Ekip rebase yapabilsin diye ana çalışma ağacındaki Faz 4 değişiklikleri worktree'ye taşındı; ana ağaçta önceden var olan `docs/` korunuyor.

## Rebase sonrası bulunanlar

- `ZoneSectorLayer` ve sektör hesaplamaları zaten vardı; dokunulmadı.
- `GridLayer` menzile göre halkalar çiziyordu, fakat 3,2 km üssü halkası yoktu.
- `BriefCard` kategori, kural puanı, bulgular ve rapor değerlendirmesi gösteriyordu; assessor olasılığı, tek alarmın kanıt zinciri ve dost iddiası rozeti yoktu.
- Kararlar UI'da sabit `nöbetçi-1` operatörüyle üretiliyor, API'de `_DECISIONS` adlı bellekte saklanıyordu. FixtureApi da kararları bellekte tutuyordu.
- Ayrı bir senaryo veri modeli/listesi bulunamadı. Yanıt beklenen açıklama sorusu için geçici yorum: her alarm bir izleme senaryosu olarak panelde gösteriliyor.

## Uygulanan değişiklikler

- Assessor olasılığı `Alert.agent_probability` üzerinden canlı kare yüküne taşındı. Kural fallback'i olasılık uydurmaz; kartta `—` görünür. BriefCard kategori, olasılık, yaklaşma/JEV güveni, kanıt kimlikleri, bağlı rapor kararları ve `identified_friendly` raporu için `Dost iddiası — insan teyidi` rozetini gösteriyor.
- Her alarm için senaryo panelinde `İzlemeye al / Geçersiz / Doğrulandı` ve kart için `Tehdidi onayla / Yanlış alarm` seçimleri var. Operatör kimliği ile gerekçe girilmeden butonlar çalışmıyor.
- Modal kararları da kimlik ve gerekçe istiyor. Kimlik, sonraki kararlar ve sesli karar için tarayıcıda hatırlanıyor; sunucuya her kararla ayrıca gönderiliyor. Bu bir kimlik doğrulama mekanizması değil.
- API kararın hedef türü ve kimliğini, gerekçesini, operatörünü ve sunucu zamanını JSONL dosyasına yazar; `GET /decisions` dosyadan okur. FixtureApi karar kaydını canlı API'ye gönderir; bellekte karar tuttuğunu iddia etmez. Docker Compose'da `/app/data/processed` için volume eklendi.
- GridLayer 1, 2 ve 3,2 km halkalarını içeriyor. Isı görünümü etiketi `Sektör hareketliliği` olarak değişti. Sektör görselleştirmesi rebase ile zaten mevcuttu.

## Doğrulama

- Web: 252 test geçti; `tsc --noEmit` geçti.
- Python: 62 hedefli test geçti; 12 HTTP TestClient testi bu ortamda bekleme sorunu nedeniyle seçilmedi. Karar endpointinin kalıcılık ve zorunlu alan testleri doğrudan geçti.
- `git diff --check` kontrol edildi.

## Açık entegrasyon sınırları

- “Senaryo” kaynağı ekip tarafından netleştirilirse geçici alarm=senaryo eşlemesi buna göre değişmeli.
- Cloud Run'ın yerel dosya sistemi örnek/redeploy arasında kalıcı değildir. JSONL kalıcılığı Docker Compose volume ve tek sunucu süreci için geçerlidir; Cloud Run'a taşınırsa bağlı kalıcı depolama veya harici veritabanı gerekir.
- Operatör adı kullanıcı girdisidir; sistemde gerçek oturum/kimlik doğrulama bulunmadığı için kimlik doğrulanmış sayılmaz.

## `origin/main` üzerine rebase

- `dgkngk/phase_4` dalının yalnızca Faz 4 commit'i `origin/main` üzerine taşındı. `main`e zaten alınan Faz 3 commit'i yeniden oynatılmadı.
- Tek çatışma `tests/test_api_rest.py` içindeydi. `main`deki istemci başlığı/CORS güvenlik testleri ve Faz 4 karar kalıcılığı testleri birlikte korundu.
- Rebase sonrası TypeScript kontrolü geçti. Web testlerinde 255 geçti, 4 fixture beklentisi uyuşmadı: beklenen 158 alarm yerine üretilen 149 alarm; 33 ALERT yerine 23; 4 izsiz alarm yerine 7; `img_008333` beklenen WATCH yerine ALERT. Bu fixture sayıları/kodları Faz 4 diff'inde değiştirilmedi. REST `TestClient` testleri bu ortamda yine bekledi; doğrudan karar doğrulama testleri geçti.
