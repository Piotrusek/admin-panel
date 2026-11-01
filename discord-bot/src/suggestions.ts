import { ChannelType, PermissionFlagsBits, type Guild, type ThreadChannel } from 'discord.js';
import type { TicketConfig } from './tickets.js';
export class SuggestionError extends Error {constructor(public code:string){super(code);}}
const snowflake=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{16,19}$/.test(v);
export async function suggestionForum(guild:Guild,config:TicketConfig) {
 if(!config.suggestionsForumId)throw new SuggestionError('suggestions-unconfigured');
 const forum=await guild.channels.fetch(config.suggestionsForumId,{force:true});
 const me=await guild.members.fetchMe();
 if(!forum||forum.type!==ChannelType.GuildForum||!forum.viewable||!forum.permissionsFor(me)?.has(PermissionFlagsBits.ReadMessageHistory))throw new Error('Suggestions forum unavailable');
 return forum;
}
export async function suggestionThread(guild:Guild,config:TicketConfig,id:unknown) {
 if(!snowflake(id))throw new Error('Invalid thread');
 const forum=await suggestionForum(guild,config),thread=await guild.channels.fetch(id,{force:true});
 if(!thread?.isThread()||thread.parentId!==forum.id||!thread.viewable)throw new Error('Not a suggestion thread');
 return {forum,thread};
}
// Snowflakes encode creation time; compare as bigint to avoid losing timestamp precision.
export const activityId=(t:Pick<ThreadChannel,'id'|'lastMessageId'>)=>BigInt(t.lastMessageId??t.id);
export const newestActivity=(a:Pick<ThreadChannel,'id'|'lastMessageId'>,b:Pick<ThreadChannel,'id'|'lastMessageId'>)=>activityId(a)>activityId(b)?-1:activityId(a)<activityId(b)?1:BigInt(a.id)>BigInt(b.id)?-1:BigInt(a.id)<BigInt(b.id)?1:0;
const archives=new WeakMap<Guild,Map<string,{expires:number;threads:ThreadChannel[]}>>();
const row=(t:ThreadChannel)=>({id:t.id,name:t.name,guildId:t.guild.id,tagIds:t.appliedTags,archived:!!t.archived,locked:!!t.locked,createdAt:t.createdTimestamp,lastMessageAt:Number(activityId(t)>>22n)+1420070400000});
const editing=new Set<string>();
// Index complete thread histories on demand. Invalidate when the latest message changes.
const messageTextCache=new Map<string,{activity:string;expires:number;text:string}>();
async function textMatches(t:ThreadChannel,needle:string):Promise<boolean> {
 const activity=t.lastMessageId??t.id,stored=messageTextCache.get(t.id);
 if(stored?.activity===activity&&stored.expires>Date.now())return stored.text.includes(needle);
 const parts:string[]=[];let before:string|undefined;
 do {
  const batch=await t.messages.fetch({limit:100,before,cache:false});
  if(!batch.size)break;
  for(const m of batch.values()){
   parts.push(m.content,...m.embeds.flatMap(e=>[e.title??'',e.description??'',...e.fields.flatMap(f=>[f.name,f.value])]),...m.attachments.map(a=>a.name));
  }
  if(batch.size<100)break;
  before=batch.last()!.id;
 }while(true);
 const text=parts.join(' ').toLocaleLowerCase();
 messageTextCache.set(t.id,{activity,expires:Date.now()+300000,text});
 if(messageTextCache.size>2000)messageTextCache.delete(messageTextCache.keys().next().value!);
 return text.includes(needle);
}

export async function suggestionCommand(guild:Guild,config:TicketConfig,c:Record<string,unknown>):Promise<{messages:unknown[];hasMore:boolean}> {
 if(c.action==='suggestions-list'){
  if(c.query!==undefined&&(typeof c.query!=='string'||c.query.length>160))throw new Error('Invalid search query');
  const needle=typeof c.query==='string'?c.query.trim().toLocaleLowerCase():'';
  if(c.cursor!==undefined&&(typeof c.cursor!=='string'||! /^[0-9]{1,16}$/.test(c.cursor)))throw new Error('Invalid cursor');
  const filters=c.tags??[];if(!Array.isArray(filters)||filters.length>20||!filters.every(snowflake))throw new Error('Invalid tag filters');
  if(c.untagged!==undefined&&typeof c.untagged!=='boolean'||c.untagged===true&&filters.length)throw new Error('Invalid untagged filter');
  const matches=(t:ThreadChannel)=>t.viewable&&(c.untagged!==true||t.appliedTags.length===0)&&filters.every(id=>t.appliedTags.includes(id));
  const forum=await suggestionForum(guild,config);let threads:ThreadChannel[],hasMore=false,cursor:string|undefined;
  const offset=Number(c.cursor??0);
  if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new Error('Invalid offset');
  let source:ThreadChannel[];
  if(c.archived===true||needle){
   let cache=archives.get(guild);if(!cache){cache=new Map();archives.set(guild,cache);}
   const cached=cache.get(forum.id);
   if(cached&&cached.expires>Date.now())source=cached.threads;
   else {
    source=[];let before:Date|undefined;const deadline=Date.now()+12000;
    // Discord archives are ordered by archive date, so collect before sorting/paging by message time.
    for(;;){
     const result=await forum.threads.fetchArchived({type:'public',limit:100,before},false);
     const batch=[...result.threads.values()];source.push(...batch);
     if(!result.hasMore)break;
     const oldest=batch.at(-1)?.archiveTimestamp;
     if(!oldest||before&&oldest>=before.getTime()||source.length>=10000||Date.now()>deadline)throw new Error('Archive listing exceeds capacity; retry later');
     before=new Date(oldest);
    }
    cache.set(forum.id,{expires:Date.now()+30000,threads:source});
   }
  }else source=[...(await forum.threads.fetchActive(false)).threads.values()];
  if(needle){
   const active=[...(await forum.threads.fetchActive(false)).threads.values()];
   source=[...new Map([...source,...active].map(t=>[t.id,t])).values()];
  }
  let all=source.filter(matches);
  if(needle){
   const found:ThreadChannel[]=[];
   // Limit parallel Discord requests to avoid bursts; include matches in any message.
   let next=0;
   await Promise.all(Array.from({length:Math.min(4,all.length)},async()=>{
    while(next<all.length){
     const t=all[next++]!;
     if(t.name.toLocaleLowerCase().includes(needle)||await textMatches(t,needle))found.push(t);
    }
   }));
   all=found;
  }
  all.sort(newestActivity);
  threads=all.slice(offset,offset+24);hasMore=offset+24<all.length;cursor=String(offset+24);

  return {messages:[{forumId:forum.id,name:forum.name,guildId:guild.id,tags:forum.availableTags.map(t=>({id:t.id,name:t.name,moderated:t.moderated})),cursor},...threads.map(row)],hasMore};
 }
 if(c.action!=='suggestions-tags')throw new Error('Unknown suggestion command');
 if(!snowflake(c.channel)||editing.has(c.channel))throw new Error('Tag edit in progress');
 editing.add(c.channel);
 try{
  const {forum,thread}=await suggestionThread(guild,config,c.channel);
  const valid=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=5&&v.every(snowflake)&&new Set(v).size===v.length;
  if(!valid(c.tags)||!valid(c.expected)||c.tags.some(id=>!forum.availableTags.some(t=>t.id===id)))throw new Error('Invalid forum tags');
  if([...thread.appliedTags].sort().join(',')!==[...c.expected].sort().join(','))throw new SuggestionError('suggestions-conflict');
  const me=await guild.members.fetchMe();
  if(thread.archived||thread.locked||!thread.permissionsFor(me)?.has(PermissionFlagsBits.ManageThreads))throw new SuggestionError('suggestions-readonly');
  const updated=await thread.setAppliedTags(c.tags,'Admin panel suggestion tags');
  return {messages:[row(updated)],hasMore:false};
 }finally{editing.delete(c.channel);}
}
