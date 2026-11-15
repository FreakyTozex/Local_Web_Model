# Conversa local

Interface web para conversar com modelos servidos pelo LM Studio através da API compatível com OpenAI. A página e o proxy correm localmente.

## Requisitos

- Python 3.9 ou superior
- LM Studio instalado, com um modelo carregado e o servidor local iniciado

## Iniciar

1. No LM Studio, abre **Developer** ou **Local Server**, carrega o modelo e inicia o servidor. O endereço padrão é `http://127.0.0.1:1234`.
2. Abre um terminal nesta pasta e executa:

   ```powershell
   python server.py
   ```

3. Abre <http://127.0.0.1:8000> no navegador e escolhe um dos modelos disponíveis.

Por omissão, a aplicação usa a API em `http://127.0.0.1:1234/v1`. Se alteraste a porta do servidor no LM Studio, define o endereço base da API (incluindo `/v1`) antes de iniciar:

```powershell
$env:MODEL_BASE_URL = "http://127.0.0.1:1234/v1"
$env:PORT = "8000"
python server.py
```

Se ativaste autenticação no servidor, podes definir também `MODEL_API_KEY`.

## Privacidade

O histórico existe apenas na memória do separador do navegador. O servidor não grava conversas em disco. A webapp escuta apenas em `127.0.0.1`, e encaminha pedidos para o endereço indicado em `MODEL_BASE_URL`.
