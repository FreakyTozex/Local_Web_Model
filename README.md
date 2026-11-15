# Conversa local

Interface web para conversar com modelos servidos pelo LM Studio através da API compatível com OpenAI. A página e o proxy correm localmente.

## Requisitos

- Python 3.9 ou superior
- LM Studio instalado, com um modelo carregado e o servidor local iniciado
- Dependências da aplicação instaladas com `pip install -r requirements.txt`

## Iniciar

1. No LM Studio, abre **Developer** ou **Local Server**, carrega o modelo e inicia o servidor. O endereço padrão é `http://127.0.0.1:1234`.
2. Abre um terminal nesta pasta, instala a dependência de PDF (uma vez) e inicia a app:

   ```powershell
   python -m pip install -r requirements.txt
   python server.py
   ```

3. Abre <http://127.0.0.1:8000> no navegador e escolhe um dos modelos disponíveis.

## Configuração

Edita o ficheiro `.env` nesta pasta e reinicia `server.py` para aplicar as alterações:

```dotenv
MODEL_BASE_URL=http://127.0.0.1:1234/v1
PORT=8000
MODEL_API_KEY=
LMSTUDIO_CHAT_MODE=native
LMSTUDIO_INTEGRATIONS_JSON=[]
```

`MODEL_API_KEY` pode ficar vazio se a autenticação estiver desligada no LM Studio. O ficheiro `.env` é ignorado pelo Git; `.env.example` serve de modelo.

## Acesso à Internet com MCP

A app usa a API nativa `/api/v1/chat` do LM Studio, que permite ao modelo chamar ferramentas MCP. Requer LM Studio 0.4.0 ou superior. A app não inclui um serviço de pesquisa: instala/configura um MCP de pesquisa ou navegador no LM Studio e permite o seu uso pelo servidor API.

1. No LM Studio, configura um MCP de pesquisa/navegação em **Program > MCP**. Por exemplo, o Playwright MCP oficial usa Node.js 20 ou superior e esta configuração em `mcp.json`:

   ```json
   {
     "mcpServers": {
       "playwright": {
         "command": "npx",
         "args": ["@playwright/mcp@latest"]
       }
     }
   }
   ```

   O Playwright MCP permite ao agente abrir páginas e interagir com elas. Consulta a [documentação do LM Studio sobre MCP](https://lmstudio.ai/docs/app/mcp) e o [guia oficial do Playwright MCP](https://playwright.dev/docs/getting-started-mcp).
2. Em **Developer > Server Settings**, ativa a permissão adequada: **Allow calling servers from mcp.json** para MCPs guardados no LM Studio, ou **Allow per-request MCPs** para MCPs remotos definidos em cada pedido.
3. No `.env`, indica a integração configurada. Por exemplo, se o servidor MCP tiver o identificador `playwright`:

   ```dotenv
   LMSTUDIO_CHAT_MODE=native
   LMSTUDIO_INTEGRATIONS_JSON=["mcp/playwright"]
   ```

   Para limitar o acesso a ferramentas específicas, usa um objeto:

   ```dotenv
   LMSTUDIO_INTEGRATIONS_JSON=[{"type":"plugin","id":"mcp/playwright","allowed_tools":["browser_navigate"]}]
   ```

   Substitui o identificador e os nomes das ferramentas pelos que o teu MCP realmente disponibiliza. MCPs definidos em `mcp.json` requerem autenticação da API no LM Studio; guarda o token em `MODEL_API_KEY`. Usa apenas MCPs de confiança, porque as ferramentas podem aceder à rede ou executar ações no computador.
4. Reinicia `server.py`. Quando o modelo chamar uma ferramenta, a app mostra o nome durante a execução.

O identificador e a lista de ferramentas dependem do MCP que instalares. O modelo também tem de suportar chamadas a ferramentas. Se precisares de usar apenas a API OpenAI-compatible antiga, define `LMSTUDIO_CHAT_MODE=openai`; nesse modo, as integrações MCP não ficam disponíveis.

## Anexos e controlo da resposta

Usa o botão **＋** junto à caixa de mensagem para anexar ficheiros PDF, Word (.docx), texto, código e dados (como TXT, Markdown, CSV, JSON, HTML, Python e SQL) ou imagens PNG, JPEG, WebP e GIF. O texto de PDFs e documentos Word é extraído localmente. PDFs com até 8 páginas também são enviados como imagens para preservar gráficos e layout; em PDFs maiores, páginas digitalizadas sem texto são enviadas como imagens (até 8). Imagens de documentos Word também são incluídas. O modelo carregado no LM Studio tem de suportar visão para interpretar imagens e páginas digitalizadas.

O limite por ficheiro é 2 MB para texto, 15 MB para PDF/Word e 12 MB para imagens. PDF protegido por palavra-passe e o formato Word antigo (.doc) não são suportados. Durante a geração, o botão de envio muda para **■**; carrega nele para parar a resposta.

Se a leitura de PDF falhar por causa do PyMuPDF, a mensagem de erro indica o interpretador Python usado pelo servidor e o comando de reparação correspondente. Usa esse comando no terminal e reinicia a app.

Por omissão, a aplicação usa a API em `http://127.0.0.1:1234/v1`.

## Persistência e privacidade

As conversas são guardadas no armazenamento local do navegador (IndexedDB), incluindo o contexto das mensagens e anexos, para poderem ser reabertas depois de fechar o separador. O histórico fica nesse perfil de navegador e não é sincronizado entre dispositivos. O servidor da app não grava conversas em disco. A webapp escuta apenas no endereço configurado no arranque e encaminha pedidos para o LM Studio.
