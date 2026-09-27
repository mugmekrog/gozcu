# Faz 3 — ajan katmanı ve JEV ikinci görüş (2026-09-27)

Dal: `dgkngk/phase_3`. Bu kayıt, ekipteki paralel değişikliklerle çatışma çözümü için tutulur.

## Karar ve değişiklikler

- Son kullanıcı kararı önceki `docs/superpowers/specs/2026-09-26-jev-threat-decisions-design.md` belgesindeki JEV seviye sahipliğini geçersiz kılar: seviye kurallar ve GLM assessor tarafından belirlenir. JEV yalnızca aynı kanıt paketi ve assessor kararı üzerinden destek puanı verir. Belge başka ajana ait, değiştirilmedi.
- `libs/goru_core/schemas.py`: assessor yanıtına 0–1 olasılık, rapor ve senaryo yorumları ve yapılandırılmış rapor değerlendirmesi eklendi.
- `services/api/app/agents/assessor.py` ve istemi: çelişen saha raporunun `agrees` olarak terfi ettirilmesi reddedilir; seviye tabanı korunur; alarm önceliği aşağı çekilmez.
- `services/api/app/api/rest.py`: `/agents/assess/{image_id}` önce GLM assessor'ü çalıştırır, sonucu `apply_assessment_to_alerts` ile işler, sonra JEV'e assessor kararını gönderir.
- `services/api/app/agents/threat_decisions.py` ve `jev.py`: TypeSafe `score` primitive'i kullanılır. İki ölçütlü 0–1 puan karar desteği olarak `jev_confidence` alanına gider; JEV alarm seviyesi yaratmaz ya da değiştirmez. 0.5 altındaki destek alarm kartına `modeller ayrışıyor` ekler. İstek sürümü 2 yapıldı; eski `choice` yanıtları yeni önbelleğe alınmaz.
- `web/src/domain/brief.ts`, `BriefCard.tsx` ve `AlertModal.tsx`: ayrışma metni kartta ve alarm penceresinde gösterilir; eski JEV seviye karşılaştırması kaldırıldı.
- `goru.yaml`: GLM ve JEV prova modu önbellekle sınırlı. JEV önbellek kaçırmasında sağlayıcı çağrısı yapılmaz. Canlı 40 görüntü turu çalıştırılmadı; paket sabitleme ve maliyet ölçümü bekliyor.
- `tests/`: skor sözleşmesi, GLM seviye sahipliği, ayrışma, önbellek, bütçe ve çelişen rapor guardrail'i için testler güncellendi.

## Doğrulama

- Hedefli Python: 59 geçti, 13 seçilmedi.
- REST akışının iki doğrudan async testi geçti. Diğer REST testlerinin `TestClient` çağrısı bu ortamda yanıt vermeden bekliyor; tam REST paketi doğrulanmadı.
- Web TypeScript kontrolü geçti; `App.test.tsx` 7 test geçti.
- `git diff --check` temiz.
- Canlı model çağrısı ve ücretli 40 görüntü turu yapılmadı; bu provada harcama $0.

## Entegrasyon notu

`jev_confidence`, sağlayıcının ayrı `confidence` alanı değil, iki ölçütlü `score` sonucu. TypeSafe'ın Score belgeleri score'u ölçütler arasındaki konum olarak tanımlar; burada iki ölçüt seçildiği için sonuç 0–1 aralığındadır. Eski JEV seviye testleri yeni sözleşmeye uyarlandı. Bütün araçlar CLEAR olduğunda alarm kartı bulunmadığından ayrışma etiketi şu an yalnızca var olan alarm kartlarında görünür.
