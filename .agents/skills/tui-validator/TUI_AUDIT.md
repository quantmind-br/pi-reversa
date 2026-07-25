# TUI Validator - Audit Report

**Application**: `/home/diogo/dev/sm/bin/sm`
**Version**: `sm 0.1.0`
**Args**: `tui`
**Working directory**: `/home/diogo/dev/sm/.agents/skills/tui-validator`
**Timestamp**: `20260725T090240Z` UTC
**Pipeline**: `tui-validator` skill (tmux + capture-pane + optional screenshots)
**Workspace**: `/home/diogo/.cache/tui-validator/sm/20260725T090240Z`

---

## 1. Summary

Auditoria completa de `sm tui` (v0.1.0) via tmux: inventário do Help, probe de atalhos (sem teclas destrutivas), stress Unicode/paste, matriz de resize e screenshots headless. **Sem blockers; 3 majors:** (1) `c` regista target sem confirmação e poluiu o registry nesta run, (2) Help do adopt mente sobre `j/k`, (3) separador dos modais parte em `────` órfão. Navegação, tabs, filter Unicode e guard 60×20 estão sólidos.

**Severity breakdown:**

| Severity | Count |
| --- | ---: |
| Blocker | 0 |
| Major | 3 |
| Minor | 2 |
| Cosmetic | 2 |
| Info | 6 |

| Audit stat | Value |
| --- | --- |
| Captures (text + ANSI) | 101 |
| Screenshots | 15 |
| Keybindings inventoried | 49 |
| Initial geometry | 80 x 24 |
| TERM | `xterm-256color` |

---

## 2. Keybindings Inventory

Raw file: `/home/diogo/.cache/tui-validator/sm/20260725T090240Z/keybindings.json`.

| Key | Context | Description | Source | Status |
| --- | --- | --- | --- | --- |
| `?` | global | toggle help | documented+observed | active |
| `q` | global | quit | documented+observed | info |
| `C-c` | global | quit | inferred | info |
| `Esc` | global | close modal / clear filter | documented+observed | active |
| `r` | global | reload | documented | active |
| `/` | global | fuzzy filter | documented | active |
| `1` | global | Status tab | documented | active |
| `2` | global | Catalog tab | documented | active |
| `3` | global | Targets tab | documented | active |
| `4` | global | Doctor tab | documented | active |
| `5` | global | Maintenance tab | documented | active |
| `[` | global | previous tab | documented | active |
| `]` | global | next tab | documented | active |
| `Up` | global | move up | documented | active |
| `Down` | global | move down | documented | active |
| `j` | global | move down | documented | active |
| `k` | global | move up | documented | active |
| `g` | global | jump top (Maintenance: GC) | documented | active |
| `G` | global | jump bottom | documented | active |
| `PgUp` | global | page up | documented | active |
| `PgDn` | global | page down | documented | active |
| `Enter` | global | details / submit | documented | active |
| `c` | global | add cwd target | documented | active |
| `s` | status | sync | documented | active |
| `a` | status | adopt | documented | active |
| `v` | status | inspect conflict | documented | active |
| `x` | status | remove | documented | skipped |
| `Space` | catalog | mark | documented | active |
| `i` | catalog | install | documented | active |
| `p` | catalog | pull | documented | active |
| `u` | catalog | update | documented | active |
| `f` | catalog | find remote skills | documented | active |
| `s` | targets | scan | documented | active |
| `a` | targets | add target | documented | active |
| `x` | targets | remove target | documented | skipped |
| `f` | doctor | fix | documented | active |
| `g` | maintenance | GC | documented | active |
| `Tab` | forms | next field | documented |  |
| `BTab` | forms | previous field | documented |  |
| `Left` | forms | change choice | documented |  |
| `Right` | forms | change choice | documented |  |
| `j` | resolver | move down | documented |  |
| `k` | resolver | move up / keep-canonical (adopt) | documented |  |
| `d` | resolver | diff | documented | skipped |
| `C` | resolver | canonical / keep-canonical | documented |  |
| `l` | resolver | local / keep-local | documented |  |
| `m` | resolver | clean-merge | documented |  |
| `a` | resolver | review | documented |  |
| `r` | resolver-adopt | rename | documented |  |

---

## 3. Findings

### [MAJOR] `c` registra target imediatamente, sem confirmação

**Phase:** probe  
**Evidence:** captures/0051-after-action-c.txt  

No Status (e globalmente), `c` (add cwd target) aplicou a mutação na hora: a captura após a tecla mostra `✓ target registered: proj:tui-validator` e `targets` subiu de 8 para 9. Não houve modal de confirmação nem preview. Durante esta auditoria isso registrou o cwd do harness (`.../tui-validator`) no registry real do utilizador.

**Suggested fix:** Abrir um confirm/form (como sync/adopt) antes de escrever no registry, ou exigir um segundo passo (y/Enter). Documentar o comportamento se for intencional.

**Repro:**
1. sm tui a partir de um diretório ainda não registado
2. Pressionar c
3. Ver toast `target registered` sem confirmação

---

### [MAJOR] Help do adopt resolver mente sobre j/k

**Phase:** inventory  
**Evidence:** captures/0005-inventory-help-pgdn2.txt  

O modal Help diz `Adopt collision (j/k move)`, mas no adopt resolver `k` é keep-canonical e a navegação é ↑/↓ (o próprio Help, noutra linha de sync resolver, documenta j/k move corretamente só para o conflict resolver). Partilhar o layout/handler entre sync e adopt sem sinalizar a troca de modo no Help/footer leva a atalho reflexivo perigoso.

**Suggested fix:** Corrigir a secção Adopt no Help para `↑/↓ move` (como no footer). Idealmente unificar j/k nos dois resolvers ou mostrar um banner de modo.

**Repro:**
1. Abrir ?
2. PgDn até Adopt collision
3. Comparar com footer do adopt resolver (v/a em colisão)

---

### [MAJOR] Separador do modal parte em duas linhas (──── leftover)

**Phase:** visual  
**Evidence:** captures/0099-visual-sync-form.txt  

Help, Sync form, Inspect e outros popups renderizam a regra sob o título como duas linhas: uma faixa cheia de `─` e uma segunda linha `────`. Causa provável em `renderPopup`: `separator := muted.Render(strings.Repeat("─", boxWidth))` seguido de `popup.Width(boxWidth)`, onde borda+padding horizontal (~4 células) fazem o separator exceder a largura útil e wrapping.

**Suggested fix:** Usar `strings.Repeat("─", max(0, boxWidth - horizontalChrome))` alinhado ao conteúdo interno do estilo `popup`, ou deixar o lipgloss desenhar a regra sem Width conflituoso.

**Repro:**
1. 80x24, pressionar s ou ?
2. Observar linha órfã `────` sob o título

---

### [MINOR] Help quebra linhas no meio de frases/atalhos

**Phase:** visual  
**Evidence:** captures/0003-inventory-help.txt  

No Help a 80x24, linhas longas partem no meio de grupos semânticos (`g/G` sozinho, `jump` na linha seguinte; `r` / `reload` separados; `p pull` / `u update` partidos). `wrapLine` é greedy por largura e o conteúdo do Help é uma string longa por secção, o que degrada legibilidade.

**Suggested fix:** Pré-quebrar o Help em linhas ≤ innerWidth com quebras em espaços, ou encurtar as strings da secção Navigation/Actions.

**Repro:**
1. ?
2. Olhar bloco Navigation

---

### [MINOR] Paste com newline no filter vira espaço

**Phase:** stress  
**Evidence:** captures/0092-stress-paste-after.txt  

Com filter aberto (`/`), `--paste-bracketed` de `hello\nworld` resultou em `/ hello world` (newline colapsado para espaço). Não disparou bindings do pai (bom), mas multi-line paste não preserva estrutura.

**Suggested fix:** Se o filter for single-line, documentar/normalizar newlines explicitamente; se quiser multi-line, preservar ou rejeitar o paste.


---

### [COSMETIC] Nome de skill truncado sem elipse no Status 80 col

**Phase:** visual  
**Evidence:** captures/0094-visual-default.txt  

`ideation-performance-optimization` aparece como `ideation-performance-optimiza` sem indicador de truncagem (`…`). Em wide/huge a coluna cresce e o detalhe lateral aparece, mas no baseline 80x24 a perda é silenciosa.

**Suggested fix:** Truncar com `…` via lipgloss ou reserva de célula, e/ou tooltip no Enter details.


---

### [COSMETIC] Help scrollable mostra duas linhas de hint ↑/↓

**Phase:** visual  
**Evidence:** captures/0003-inventory-help.txt  

Com corpo maior que a janela, o Help injeta `↑/↓ scroll · N above · M below` no body e ainda renderiza o tail padrão `↑/↓ scroll · Enter/Esc close`, duplicando a dica.

**Suggested fix:** Quando houver scrollbar hint no body, omitir a parte ↑/↓ do tail ou fundir num único footer do popup.


---

### [INFO] Skipped destructive keys (danger list)

**Phase:** probe  
**Evidence:** n/a  

Não foram enviadas: d, D, x, X, Delete, Backspace (fora de input), C-k, C-w, C-u, !, :q!. Em particular `x` (remove) e `d` (diff no resolver) ficaram de fora. Re-correr com --allow-destructive / opt-in explícito para as testar. Ações mutáveis s/a/i/p/u/f/g foram abertas e canceladas com Esc (exceto `c`, que aplica logo).

**Suggested fix:** Re-run com opt-in do utilizador para x/remove e fluxos confirmados.


---

### [INFO] Navegação j/k/↑/↓ só diferenciável em ANSI

**Phase:** probe  
**Evidence:** captures/0074-ansi-after-down.ansi  

Diff de `.txt` marcou Down/Up/j/k como dead porque a seleção usa reverse video (`[1;7m`) e o texto plano fica idêntico. Diff `--ansi` confirma active (highlight move agent-browser → agent-reach).

**Suggested fix:** Nada a corrigir na TUI; inventário marcado active via ANSI.


---

### [INFO] Guard screen em 60×20 funciona

**Phase:** visual  
**Evidence:** captures/0095-visual-tiny.txt  

Em tiny (60×20) a TUI mostra `Terminal too small: resize to 80x20 · q quit (have 60x20)` e não tenta layout partido. Em 80×20 o Status principal renderiza.


---

### [INFO] Unicode/emoji/NFD no filter OK; Ctrl unbound safe

**Phase:** stress  
**Evidence:** captures/0080-stress-latin-after.txt  

Filter aceitou `ção não coração`, `€£¥ ©® §¶`, `中文 你好`, `😀🚀`, NFD `e+U+0301`→`é`, input rápido `abcdefghijklmnop`. C-g/C-n/C-p sem crash nem side-effect visual.


---

### [INFO] Screenshots live Wayland falharam (session lock)

**Phase:** visual  
**Evidence:** screenshots/default.png  

grim/hyprctl reportou session lock; as PNGs iniciais capturaram o lock screen. Gallery regenerada via aha+Chromium headless a partir dos `.ansi` (qualidade inferior a terminal nativo).


---

### [INFO] Side-effect da auditoria: target proj:tui-validator

**Phase:** probe  
**Evidence:** captures/0051-after-action-c.txt  

Por causa de A-01, o registry ficou com `proj:tui-validator` apontando a `.../sm/.agents/skills/tui-validator`. Remover manualmente se não for desejado (`sm` Targets tab `x`, ou CLI equivalente).

**Suggested fix:** Limpar o target espúrio após rever A-01.

---

## 4. Visual Gallery

Diff maps, when generated with `tui-screenshot.sh --diff`, are stored next to
the screenshots.

#### default

![default](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/default.png)

#### help-modal

![help-modal](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/help-modal.png)

#### help-modal-vs-default

![help-modal-vs-default](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/help-modal-vs-default.png)

#### huge

![huge](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/huge.png)

#### huge-vs-default

![huge-vs-default](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/huge-vs-default.png)

#### min-80x20

![min-80x20](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/min-80x20.png)

#### min-80x20-vs-default

![min-80x20-vs-default](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/min-80x20-vs-default.png)

#### sync-form

![sync-form](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/sync-form.png)

#### sync-form-vs-default

![sync-form-vs-default](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/sync-form-vs-default.png)

#### tall

![tall](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/tall.png)

#### tall-vs-default

![tall-vs-default](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/tall-vs-default.png)

#### tiny

![tiny](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/tiny.png)

#### tiny-vs-default

![tiny-vs-default](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/tiny-vs-default.png)

#### wide

![wide](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/wide.png)

#### wide-vs-default

![wide-vs-default](/home/diogo/.cache/tui-validator/sm/20260725T090240Z/screenshots/wide-vs-default.png)



---

## 5. Methodology

### Phases Executed

| Phase | What was done | Status |
| --- | --- | --- |
| 1. Discover | `bin/sm` rebuild, `--help`/`--version`, docs AGENTS.md + help modal source | done |
| 2. Inventory | `?` help + PgDn; footer hints; `keybindings.json` (49) | done |
| 3. Probe | Nav/tabs/filter/actions open+Esc; ANSI recheck j/k; skip danger list | done |
| 4. Stress | Latin/CJK/emoji/NFD/symbols, bracketed paste, rapid, C-g/n/p | done |
| 5. Visual | tiny/default/wide/tall/huge + min 80×20; help + sync form shots | done |
| 6. Report | findings.json → report.md + TUI_AUDIT.md | done |

### Coverage

- **Keys probed**: `? / r 1-5 [ ] ↑↓ j k g G PgUp PgDn Enter c s a v Space i p u f` (+ Esc restore); forms opened then cancelled
- **Modes tested**: Status, Catalog, Targets, Doctor, Maintenance, Help modal, Sync form, Inspect message, Filter
- **Geometries**: 60×20, 80×20, 80×24, 80×50, 160×40, 200×60
- **Not tested (and why)**: `x`/`d`/Delete/Backspace/C-k/C-w/C-u (danger list); confirm+apply de sync/adopt/install/pull/update/fix/GC (mutam recursos reais); resolver com linha `diverged` (fixture inexistente nesta registry); `q`/`C-c` (encerrariam a sessão a meio)

### Limitations

- Screenshots Wayland/grim falharam por **session lock**; gallery = aha + Chromium headless a partir de `.ansi` (sem cores Catppuccin fiéis).
- Launch cwd foi o dir da skill (harness), não o repo — daí o side-effect `proj:tui-validator`.
- Diffs pixel vs default comparam viewports de tamanhos diferentes (AE enorme); úteis só como prova de mudança, não regressão visual fina.
- Teclas de formulário Tab/←/→ no form não foram classificadas individualmente além de abrir Sync.

---

## 6. Reproducibility

| Finding | Repro from fresh boot? | Steps |
| --- | --- | --- |
| A-01 `c` sem confirm | sim | `sm tui` num cwd não registado → `c` → toast register |
| B-01 Help adopt j/k | sim | `?` → PgDn até Adopt collision |
| R-01 separator wrap | sim | `s` ou `?` a 80×24 → linha `────` sob o título |

---

## 7. Improvement Suggestions

- Confirmação uniforme para qualquer mutação de registry/lock (incluindo `c`).
- Unificar modelo mental dos resolvers (sync vs adopt) ou banner de modo óbvio.
- Pré-wrap do texto de Help; elipse em truncagens de skill.
- Teste de integração que falha se `renderPopup` produzir separator com `lipgloss.Height > 1`.

---

## 8. Prioritized Recommendations

| Priority | Item | Resolves |
| --- | --- | --- |
| P0 | Confirm/form antes de `c` add cwd | A-01, I-06 |
| P0 | Corrigir Help adopt (`↑/↓ move`) | B-01 |
| P1 | Fix `boxWidth` vs border/padding no separator | R-01 |
| P2 | Word-aware wrap no Help + elipse truncagem | R-02, R-03 |
| P3 | Fundir hints de scroll duplicados no Help | R-04 |

---

## 9. Workspace

```
/home/diogo/.cache/tui-validator/sm/20260725T090240Z/
├── meta.json
├── keybindings.json
├── findings.json
├── captures/      (101 text + ANSI scrapes)
└── screenshots/   (15 PNGs)
```

---

## 10. Appendix - Environment

- **TERM**: `xterm-256color`
- **Initial geometry**: 80 x 24
- **Binary**: `/home/diogo/dev/sm/bin/sm`
- **Version**: `sm 0.1.0`
- **Args**: `tui`
- **CWD**: `/home/diogo/dev/sm/.agents/skills/tui-validator`
