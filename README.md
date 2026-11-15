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
```

`MODEL_API_KEY` pode ficar vazio se a autenticação estiver desligada no LM Studio. O ficheiro `.env` é ignorado pelo Git; `.env.example` serve de modelo.

## Anexos e controlo da resposta

Usa o botão **＋** junto à caixa de mensagem para anexar ficheiros PDF, Word (.docx), texto, código e dados (como TXT, Markdown, CSV, JSON, HTML, Python e SQL) ou imagens PNG, JPEG, WebP e GIF. O texto de PDFs e documentos Word é extraído localmente. PDFs com até 8 páginas também são enviados como imagens para preservar gráficos e layout; em PDFs maiores, páginas digitalizadas sem texto são enviadas como imagens (até 8). Imagens de documentos Word também são incluídas. O modelo carregado no LM Studio tem de suportar visão para interpretar imagens e páginas digitalizadas.

O limite por ficheiro é 2 MB para texto, 15 MB para PDF/Word e 12 MB para imagens. PDF protegido por palavra-passe e o formato Word antigo (.doc) não são suportados. Durante a geração, o botão de envio muda para **■**; carrega nele para parar a resposta.

Por omissão, a aplicação usa a API em `http://127.0.0.1:1234/v1`.

## Privacidade

O histórico existe apenas na memória do separador do navegador. O servidor não grava conversas em disco. A webapp escuta apenas em `127.0.0.1`, e encaminha pedidos para o endereço indicado em `MODEL_BASE_URL`.
