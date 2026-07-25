import { PIPELINE_IDS, PIPELINES } from "./pipelines.js";

/**
 * Build the launcher prompt for `/reversa-auto`.
 *
 * The parent model does exactly two things: run one interview, then call
 * `reversa_orchestrate` once. Everything the pipeline needs is decided here,
 * because once the tool is running there is no structural opportunity to ask.
 *
 * @param {object} input
 * @param {boolean} input.askToolAvailable whether `ask_user_question` is registered
 * @param {string} input.pipeline
 * @param {Record<string, any>} [input.state] current .reversa/state.json
 * @param {{ granularity?: string }} [input.specs] current [specs] section
 * @returns {string}
 */
export function buildLauncherPrompt({ askToolAvailable, pipeline, state = {}, specs = {} }) {
  const definition = PIPELINES[pipeline];
  const stageLabels = definition.stages.map((stage) => stage.label).join(" → ");

  const known = [];
  const missing = [];
  const track = (label, value) => (value ? known : missing).push(label);

  track("user_name", state.user_name);
  track("chat_language", state.chat_language);
  track("doc_language", state.doc_language);
  track("project", state.project);
  track("doc_level", state.doc_level);
  track("specs_choice", state.specs_choice ?? specs.granularity);

  const askingBlock = askToolAvailable
    ? [
        "Use a ferramenta `ask_user_question` para coletar as respostas.",
        "Regras do widget: no máximo 4 perguntas por chamada (faça uma segunda chamada se precisar de mais), `header` com no máximo 16 caracteres, cada pergunta com 2 a 4 opções, cada `label` com no máximo 60 caracteres.",
        'Não crie a opção "Other" nem a linha "Type something." — o Pi já as adiciona automaticamente, e é por elas que o usuário digita texto livre.',
      ].join("\n")
    : [
        "A ferramenta `ask_user_question` não está disponível nesta sessão.",
        "Apresente um menu numerado no chat, com todas as perguntas de uma vez, e aguarde uma única resposta consolidada do usuário.",
        "Recomende ao usuário instalar `pi install npm:@juicesharp/rpiv-ask-user-question` para uma entrevista com widget.",
      ].join("\n");

  return [
    "Você é o lançador do Reversa autônomo. Só existem dois passos: coletar as respostas da entrevista e chamar a ferramenta `reversa_orchestrate`. Nada além disso.",
    "",
    `Pipeline solicitado: \`${pipeline}\` (${definition.label}) — etapas: ${stageLabels}.`,
    "",
    "## 1. O que já se sabe",
    "",
    "Leia `.reversa/state.json` e `.reversa/config.toml` antes de perguntar qualquer coisa. **Só pergunte o que ainda não está preenchido.**",
    known.length ? `Já preenchido (não perguntar): ${known.join(", ")}.` : "Nada preenchido ainda.",
    missing.length ? `Ainda falta: ${missing.join(", ")}.` : "Nada falta — vá direto para o passo 3.",
    "",
    "## 2. A entrevista (uma única rodada)",
    "",
    askingBlock,
    "",
    "Perguntas, nesta ordem, pulando as já respondidas:",
    "",
    "**Bloco 1 — dados de instalação** (só se `user_name` estiver vazio): nome do usuário, idioma do chat, idioma das especificações e nome do projeto. Colete os quatro na mesma chamada; para os idiomas ofereça `pt-BR` e `en-US` como opções, e para nome de usuário e nome do projeto ofereça as hipóteses mais prováveis — o usuário digita o valor real pela linha de texto livre do próprio widget.",
    "",
    "**Bloco 2 — nível de documentação** (`doc_level`):",
    "- `Essencial` (padrão): artefatos principais (code-analysis, domain, architecture, specs SDD). Ideal para projetos simples.",
    "- `Completo`: diagramas C4, ERD, ADRs, OpenAPI e matrizes de rastreabilidade. Recomendado para a maioria dos projetos.",
    "- `Detalhado`: máxima profundidade, flowcharts por função, ADRs expandidos, deployment, revisão cruzada obrigatória.",
    "",
    "**Bloco 3 — organização das specs** (`specs_choice`). O widget aceita no máximo 4 opções, então ofereça:",
    "- `Automática` (padrão): aceitar a sugestão que o Scout fizer após mapear o projeto → `auto`",
    "- `Por módulo` → `module`",
    "- `Por caso de uso` → `use-case`",
    "- `Híbrida` (módulo na raiz, casos de uso aninhados) → `hybrid`",
    "Se o usuário digitar texto livre pedindo endpoint, features ou pastas customizadas, mapeie para `endpoint`, `feature` ou `custom` antes de chamar a ferramenta. Para `custom`, colete também os nomes das pastas de primeiro nível e passe em `custom_folders`.",
    "",
    "Não pergunte sobre `answer_mode`: o modo autônomo sempre registra dúvidas em `questions.md`.",
    "",
    "## 3. A chamada",
    "",
    `Com todas as respostas em mãos, chame \`reversa_orchestrate\` **uma única vez**, com \`pipeline: "${pipeline}"\`.`,
    "Não peça confirmação, não anuncie que vai começar, não chame nenhum comando `/reversa-*`.",
    "**Não use a ferramenta `subagent`, `subagent_wait`, `/run`, chains ou qualquer outro mecanismo de delegação do agente para trabalho Reversa — os subagentes do Reversa são internos ao `reversa_orchestrate` e não se misturam com os do agente hospedeiro.**",
    "A ferramenta bloqueia até o pipeline inteiro terminar. Quando ela retornar, apenas repasse o relatório dela ao usuário, sem reescrever nem resumir demais.",
    "",
    "## 4. Cancelamento",
    "",
    "Se o questionário for cancelado (`cancelled: true`) ou o usuário desistir, **não** chame `reversa_orchestrate`. Diga que nada foi executado e encerre.",
  ].join("\n");
}

/**
 * Parse the optional pipeline argument of `/reversa-auto`.
 *
 * @param {string} args
 * @returns {{ pipeline: string } | { error: string }}
 */
export function parsePipelineArg(args) {
  const value = args.trim().toLowerCase();
  if (!value) return { pipeline: "discovery" };
  if (PIPELINE_IDS.includes(value)) return { pipeline: value };
  return { error: `Pipeline desconhecido: "${value}". Valores válidos: ${PIPELINE_IDS.join(", ")}.` };
}
