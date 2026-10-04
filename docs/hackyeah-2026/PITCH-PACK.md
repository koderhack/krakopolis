# KRAKOPOLIS — HackYeah 2026 Smart City · Pitch Pack

**Plik prezentacji:** `docs/hackyeah-2026/KRAKOPOLIS-HackYeah-2026.pptx`  
**Demo:** https://krakopolis.pages.dev  
**Język decka:** English (wymaganie FAQ HackYeah dla Open Tasks)  
**Limit:** ≤ 10 slajdów · PDF/PPTX · screenshots obowiązkowe

---

## Research (skrót zasad, bez kopiowania cudzych decków)

### Wymagania HackYeah 2026 (źródła publiczne)
- **Smart City (Open Task):** narzędzie/app/system/prototyp na realny problem miejski — mobilność, dane, usługi, kryzys. Pula: 8 000 PLN. PL lub EN.  
  → https://hackyeah.pl/tasks-prizes/
- **Prezentacja:** krótki plik (PowerPoint/Keynote → najlepiej też PDF), mockupy/screenshoty, zwięzły opis problemu + rozwiązania + jak działa.  
  → https://hackyeah.pl/faq/
- **Opis projektu:** ~3 akapity, nie 3 strony; **po angielsku** (jurorzy Open Tasks).
- **Kryteria Open Tasks (FAQ + Regulamin):**  
  Idea & Innovation 30% · Relation to Category 20% · Practical Applicability 20% · Design 20% · Completeness & Implementation 10%
- Edycje 2023/2024 FAQ: prezentacja **≤ 10 slajdów**, EN, PDF lub PDF+PPTX.

### Zasady z wysokiej oceny (tylko PRINCIPLES)
1. Problem i korzyść miejska przed stackiem.
2. Mało tekstu, duże visuals / działające demo.
3. Mierzalne / konkretne efekty (u nas: **MODEL ESTIMATE / SIMULATED**, nie fake KPI).
4. Design liczy się mocno (20%) — ciemny, czytelny, produktowy.
5. Jedna osoba pitchuje; Q&A trzeba przećwiczyć.
6. Juror nietechniczny musi zrozumieć w ~3 minutach.

### Persuasive arc
**Problem → Solution → Demo → Tech (lekko) → Edge**

---

## 8. Kolejność slajdów

| # | Idea | Screenshot |
|---|------|------------|
| 1 | Hook | `01-overview-hud` / assets `s1-overview.jpg` |
| 2 | Problem chain | diagram (bez fake city stats) |
| 3 | Solution loop | BUILD→SIMULATE→OBSERVE→DECIDE |
| 4 | How it works | `02-buduj-katalog` |
| 5 | Wow demo | `03-konsekwencje` + catalog numbers |
| 6 | Disasters | `07-pozar-mapa` (live capture) |
| 7 | What-if / analysis | `04-analiza-warstwy` |
| 8 | City memory | `05-historia-wersji` |
| 9 | Why Krakopolis | 3 pillars |
| 10 | End + QR | `qr-demo.png` → krakopolis.pages.dev |

---

## 1–7. Finalny tekst każdego slajdu + notatki prezentera

### SLIDE 1 — HOOK
- **Title:** KRAKOPOLIS  
- **Subtitle:** Build the city. / Test the decision. / See the consequences.  
- **Text:** Interactive Kraków decision lab  
- **Graphic:** Left brand block · right full HUD city screenshot  
- **Screenshot:** overview HUD (`s1-overview.jpg`)  
- **Presenter notes:** Cisza 1–2 s po tytule. „This is Krakopolis — a lab where you test a city decision before you commit.” Nie tłumacz stacku.

### SLIDE 2 — PROBLEM
- **Title:** Cities are complex systems.  
- **Subtitle:** People see one decision — not the chain of consequences.  
- **Text / numbers (MODEL ESTIMATE estate scenario):**  
  NEW ESTATE → +420 residents (≈ 10× catalog highrise) → more traffic → junction overload → longer trips → infra pressure  
- **Graphic:** horizontal consequence chain cards  
- **Screenshot:** none (diagram)  
- **Presenter notes:** „A new estate isn’t just housing. It’s traffic, schools, transit load.” Podkreśl: estate numbers = **MODEL ESTIMATE**, not Kraków forecast. Single highrise in app = **+44 residents** (catalog).

### SLIDE 3 — SOLUTION
- **Title:** Turn urban decisions into experiments.  
- **Subtitle:** BUILD → SIMULATE → OBSERVE → DECIDE  
- **Text:** City-builder UX on real Kraków OSM + consequence engine underneath.  
- **Graphic:** four equal cards  
- **Screenshot:** none  
- **Presenter notes:** „Not another map. A sandbox for decisions.” Unikaj słowa AI.

### SLIDE 4 — HOW IT WORKS
- **Title:** Decision → Simulation → Consequences  
- **Text:** 1 Choose · 2 Preview · 3 Enter · 4 Approve · 5 Model recalculates · 6 Observe  
- **Graphic:** numbered list + build catalog screenshot  
- **Screenshot:** Buduj katalog (`s4-build.jpg`)  
- **Presenter notes:** Mów flow jak demo: „Pick · place · Enter · see report.”

### SLIDE 5 — BEST DEMO MOMENT
- **Title:** One decision. Visible consequences.  
- **Numbers (concrete catalog):** Wysoki blok · **+44 residents** · local traffic ↑ · school demand ↑ · **9.8 mln zł** · labels SIMULATED / MODEL ESTIMATE  
- **Graphic:** metric cards + consequences UI screenshot  
- **Screenshot:** consequences / build UI (`s5-consequences.jpg`)  
- **Presenter notes:** To jest **wow**. Jeśli live demo działa — pokaż Enter tutaj. Nie obiecuj precyzji; mów „the model updates metrics and shows a consequence report.”

### SLIDE 6 — DISASTERS
- **Title:** Disasters are events, not animations.  
- **Subtitle:** EVENT → IMPACT → RESPONSE → RECOVERY  
- **Text:** Fire / flood at a map point · roads & metrics shift · you decide recovery  
- **Honest wording:** SERVICEs reaction = sim state / report text; visible firefighters still polish item.  
- **Screenshot:** live fire capture (`s6-fire.jpg`) — toast „Wykryto pożar.”  
- **Presenter notes:** „A fire is a simulation event: location, radius, road impact, metric deltas — MODEL ESTIMATE for people in range.” Nie mów „AI predicts disasters.”

### SLIDE 7 — WHAT IF
- **Title:** What happens next?  
- **Text:** NOW → short horizon → compare alternative → decide · Analysis layers labeled szacunek  
- **Graphic:** horizon strip + analysis screenshot  
- **Screenshot:** Analiza warstwy (`s7-analysis.jpg`)  
- **Presenter notes:** „What if we close a street? What if we build elsewhere?” Historia + analiza = porównanie scenariuszy.

### SLIDE 8 — CITY MEMORY
- **Title:** Every decision leaves a trace.  
- **Text:** v1–v4 · Compare · Restore · Undo/redo · persistent state  
- **Screenshot:** Historia (`s8-history.jpg`)  
- **Presenter notes:** „The city remembers. Restore doesn’t erase history — you can compare paths.”

### SLIDE 9 — WHY KRAKOPOLIS
- **Title:** Simple on the surface. Analytical underneath.  
- **Three edges:**  
  1. CITY-BUILDER UX  
  2. LOCATION-BASED SIM (OSM · live transit where available)  
  3. CONSEQUENCE ENGINE (preview → confirm · OBSERVED vs SIMULATED)  
- **Screenshot:** none  
- **Presenter notes:** Jedno zdanie o tech tylko jeśli zapytają: „Browser 3D on OSM, model in the client, Cloudflare Pages demo.” Mikrus/backend tylko przy pytaniu o dane/proxy.

### SLIDE 10 — ENDING
- **Title:** KRAKOPOLIS  
- **Tagline:** Build the city. Test the decision. See the consequences.  
- **URL + QR:** https://krakopolis.pages.dev  
- **Footer:** HackYeah 2026 · Smart City  
- **Presenter notes:** Zakończ zaproszeniem do demo. Zostaw QR na ekranie podczas Q&A.

---

## 9. Pitch ustny 60–90 s (EN — jury)

Cities are complex systems. One decision — a new block, a closed street, a flood — rarely stays local. People usually see the decision, not the chain of consequences.

**Krakopolis** turns urban decisions into experiments. You build or change something on a real Kraków map, the **simulation** recalculates, and you see **modeled consequences** before you commit — traffic, access, budget, livability. Labels stay honest: **OBSERVED** versus **SIMULATED / MODEL ESTIMATE**.

Disasters aren’t fireworks: a fire or flood is an **event** that hits roads and metrics. Every important change becomes a **city version** you can compare and restore.

Simple like a city-builder. Analytical underneath.  
Build the city. Test the decision. See the consequences.  
Try it: **krakopolis.pages.dev**.

*(≈ 75–85 s spokojnym tempem)*

### Pitch PL (backup / mentoring)

Miasta to systemy. Jedna decyzja — nowe osiedle, zamknięta ulica, pożar — rzadko zostaje lokalna. Krakopolis zamienia decyzje w eksperymenty: budujesz na realnej mapie Krakowa, **model** przelicza skutki, widzisz konsekwencje zanim zatwierdzisz. Katastrofy to zdarzenia symulacji, nie tylko efekt. Historia wersji pozwala porównać scenariusze. Proste jak city-builder. Analityczne w środku.

---

## 10. Polish aplikacji przed prezentacją

### Must-fix (demo risk)
1. **Scenariusz live 90 s:** Buduj → Wysoki blok → preview → Enter → raport → Zdarzenia → Pożar → toast + metryki → Historia → porównaj. Przećwicz 5×.
2. **Gęstość katastrof:** szacunek „ok. X osób” bywa zawyżony (np. tysiące w 220 m) — oznacz w UI wyraźniej **confidence: niska** albo skoryguj estimator przed jury.
3. **Zrzuty „wow”:** świeży screen z panelem **POŻAR ROZPOCZĘTY** (impacts LOW/MEDIUM/HIGH) na pierwszym planie — obecny 08 bywa bez czytelnego overlay.
4. **Perspektywa + HUD:** na pitchu schowaj zbędne panele (Widok → mniej clutter), zostaw metryki + tryby + raport.
5. **Offline / sieć:** upewnij się, że demo na Pages ładuje się na sali (Wi‑Fi / hotspot / lokalny build).

### Should-fix (credibility)
6. Widoczna reakcja służb przy pożarze (nawet prosty marker „response”), żeby slide 6 nie obiecywał więcej niż UI.
7. Jeden czysty scenariusz „what if”: zamknij ulicę → pokaż zmianę ruchu (warstwa Analiza).
8. Historia: przygotuj 2–3 wersje przed pitchiem (v1 baseline, v2 build, v3 disaster).
9. EN tooltips / krótkie EN labels na key HUD jeśli pitch tylko po angielsku (opcjonalnie).
10. Usuń / wycisz easter eggi (Neo) na czas jury.

### Nice-to-have
11. PDF export decka obok PPTX (FAQ: nie wszyscy otworzą PPTX).  
12. 60 s video URL (opcjonalne w starszych FAQ).  
13. Cover image do HackTribe = slide 1 lub fire+HUD.

---

## Upload checklist (HackTribe / platforma zadania)

- [ ] Presentation PPTX (**ten plik**) + najlepiej PDF  
- [ ] Image gallery: ≥1 screenshot (użyj `docs/screens/01…` i `07…`)  
- [ ] Description EN ~3 akapity (Problem / Solution / How it works)  
- [ ] Website: https://krakopolis.pages.dev  
- [ ] Code repo + boot instructions  
- [ ] Nie obiecuje „AI magic” w opisie  

---

## Ścieżka do pliku

```
docs/hackyeah-2026/
  KRAKOPOLIS-HackYeah-2026.pptx   ← FINAL DECK
  PITCH-PACK.md                   ← ten dokument
  assets/                         ← skompresowane screeny + QR
```

Stary draft: `docs/Krakopolis-Hackathon.pptx` (8 slajdów, bardziej tech) — **nie używaj na jury**; zastąp nowym.
