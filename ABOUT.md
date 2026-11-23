# O que é o Yewholt? (pt-BR)

O Yewholt é uma camada fina sobre o [Pi](https://pi.dev). O Pi é o motor:
cada agente roda como uma sessão do Pi. O
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) guarda o
**estado durável de cada agente** entre reinícios, e o Pi guarda o histórico
da sessão. O Yewholt conecta os agentes à sua comunidade no
[Buzz](https://github.com/block/buzz) pelo relay Nostr que ela já usa.

## Que problema ele resolve?

Se você quer rodar agentes de programação em uma VM Linux ou em um Mac, mas
conversar com eles pelo Buzz, não precisa abrir uma sessão SSH para cada
conversa nem copiar chaves do Nostr para conectar as máquinas.

Depois de instalar o Yewholt, um comando (`yh join --daemon` na VM ou
`yh join --local` no Mac) usa um convite do Buzz para conectar a máquina à
comunidade e iniciar o serviço em segundo plano. O plugin do Yewholt no Buzz
para Mac cuida do pareamento e permite criar agentes, escolher entre os modelos
disponíveis no Pi da máquina e conversar com eles em canais ou mensagens diretas.

É para desenvolvedores e equipes que já usam o Buzz e querem rodar agentes do Pi
nas próprias máquinas. Para começar, veja a [configuração](README.md#setup) e o
[guia de instalação na VM](skills/install/SKILL.md).

# What is Yewholt? (en)

Yewholt is a thin wrapper around [Pi](https://pi.dev). Pi is the engine:
each agent runs as a Pi session.
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) stores
**each agent's durable state** across restarts, and Pi keeps the session
history. Yewholt connects agents to your [Buzz](https://github.com/block/buzz)
community through the Nostr relay it already uses.

## What problem does it solve?

If you want to run coding agents on a Linux VM or a Mac but talk to them in
Buzz, you don't need to open an SSH session for each conversation or copy
Nostr keys to connect the machines.

After installing Yewholt, one command (`yh join --daemon` on a VM or
`yh join --local` on a Mac) uses a Buzz invite to connect the machine to the
community and start the background service. The Yewholt plugin in Buzz for Mac
handles pairing and lets you create agents, choose from the models available to
Pi on that machine, and talk to them in channels or direct messages.

It's for developers and teams who already use Buzz and want to run Pi agents
on their own machines. To get started, see the [setup instructions](README.md#setup)
and the [VM installation guide](skills/install/SKILL.md).
