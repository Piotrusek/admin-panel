import { buildSuggestionIndex, indexSuggestionMessage, invalidateSuggestionThread, removeSuggestionThread } from './suggestions.js';
import { errorDetail } from './errors.js';
import { connectConversations } from './conversations.js';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { ticketConfig, collectTickets, publishTickets } from './tickets.js';
import { loadConfig } from './config.js';
import { printGuildChannels } from './channels.js';

let client:Client|undefined;
let stopConversations=()=>{};
let ticketTimer:ReturnType<typeof setInterval>|undefined;
function report(stage:string,error:unknown) {
  console.error(`${stage}: ${errorDetail(error)}`);
}
try {
  const config=loadConfig(),tickets=ticketConfig();
  client=new Client({intents:[GatewayIntentBits.Guilds,...(tickets.url?[GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]:[])],presence:{status:'online'},allowedMentions:{parse:[]}});
  client.once(Events.ClientReady,ready=>{
    console.log(`Online as ${JSON.stringify(ready.user.tag)} (${ready.user.id}).`);
    void (async()=>{
      const guild=await ready.guilds.fetch(config.guildId);
      await printGuildChannels(guild);
      stopConversations=connectConversations(guild,tickets);
      void buildSuggestionIndex(guild,tickets).catch(error=>report('Suggestion index initialization failed',error));
      console.log('Channel listing complete. Bot remains online; press Ctrl+C to stop.');
      let syncing=false;
      const sync=async()=>{if(syncing)return;syncing=true;try{
        const rows=await collectTickets(guild,tickets);
        await publishTickets(tickets,rows);
        console.log(`Tickets: ${rows.length} matched${tickets.url?' and synced':''}.`);
      }catch(error){report('Ticket sync failed',error);}finally{syncing=false;}};
      if(tickets.categoryIds.length){await sync();ticketTimer=setInterval(()=>void sync(),30000);}
    })().catch(error=>{report('Channel listing failed',error);process.exitCode=1;client?.destroy();});
  });
  client.on(Events.MessageCreate,message=>{if(message.guild)indexSuggestionMessage(message.guild,tickets,message);});
  client.on(Events.MessageUpdate,(_old,message)=>{
    if(message.guild&&message.channel.isThread()&&message.channel.parentId===tickets.suggestionsForumId)
      invalidateSuggestionThread(message.guild,tickets,message.channel);
  });
  client.on(Events.MessageDelete,message=>{
    if(message.guild&&message.channel.isThread()&&message.channel.parentId===tickets.suggestionsForumId)
      invalidateSuggestionThread(message.guild,tickets,message.channel);
  });
  client.on(Events.MessageBulkDelete,(_messages,channel)=>{
    if(channel.isThread()&&channel.guild&&channel.parentId===tickets.suggestionsForumId)
      invalidateSuggestionThread(channel.guild,tickets,channel);
  });
  client.on(Events.ThreadCreate,thread=>{if(thread.parentId===tickets.suggestionsForumId)invalidateSuggestionThread(thread.guild,tickets,thread);});
  client.on(Events.ThreadUpdate,(_old,thread)=>{if(thread.parentId===tickets.suggestionsForumId)invalidateSuggestionThread(thread.guild,tickets,thread);});
  client.on(Events.ThreadDelete,thread=>{if(thread.parentId===tickets.suggestionsForumId)removeSuggestionThread(thread.guild,thread.id);});
  client.on(Events.Error,error=>report('Discord connection error',error));
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{console.log('Stopping Discord bot.');clearInterval(ticketTimer);stopConversations();client?.destroy();});
  await client.login(config.token);
}catch(error){
  if(!client)console.error(error instanceof Error?error.message:'Invalid bot configuration.');
  else report('Bot login failed',error);
  process.exitCode=1;client?.destroy();
}
