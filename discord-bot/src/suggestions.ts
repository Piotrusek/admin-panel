import { ChannelType, PermissionFlagsBits, type Guild, type ThreadChannel, type ForumChannel, type Message } from 'discord.js';
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
// A bounded, in-memory index. Startup indexing is asynchronous, not on the search path.
interface IndexedThread {thread:ThreadChannel;messages:Map<string,string>}
interface SearchIndex {threads:Map<string,IndexedThread>;pending:Set<string>;changes:Map<string,number>;ready:boolean;loading:boolean;indexed:number;total:number}
const indexes=new WeakMap<Guild,SearchIndex>();
const normalized=(s:string)=>s.toLocaleLowerCase();
const messageText=(m:Message)=>normalized([
 m.content,...m.embeds.flatMap(e=>[e.title??'',e.description??'',...e.fields.flatMap(f=>[f.name,f.value])]),
 ...m.attachments.map(a=>a.name)
].join(' '));
function indexFor(guild:Guild):SearchIndex {
 let idx=indexes.get(guild);
 if(!idx){idx={threads:new Map(),pending:new Set(),changes:new Map(),ready:false,loading:false,indexed:0,total:0};indexes.set(guild,idx);}
 return idx;
}
async function archivedThreads(forum:ForumChannel,guild:Guild) {
 let cache=archives.get(guild);if(!cache){cache=new Map();archives.set(guild,cache);}
 const cached=cache.get(forum.id);
 if(cached&&cached.expires>Date.now())return cached.threads;
 const source:ThreadChannel[]=[];let before:Date|undefined;
 for(;;){
  const result=await forum.threads.fetchArchived({type:'public',limit:100,before},false);
  const batch=[...result.threads.values()];source.push(...batch);
  if(!result.hasMore)break;
  const oldest=batch.at(-1)?.archiveTimestamp;
  if(!oldest||before&&oldest>=before.getTime()||source.length>=10000)throw new Error('Archive listing exceeds capacity');
  before=new Date(oldest);
 }
 cache.set(forum.id,{expires:Date.now()+30000,threads:source});
 return source;
}
async function refreshIndexedThread(idx:SearchIndex,t:ThreadChannel) {
 const revision=idx.changes.get(t.id)??0;
 const messages=new Map<string,string>();let before:string|undefined;
 for(;;){
  const batch=await t.messages.fetch({limit:100,before,cache:false});
  if(!batch.size)break;
  for(const m of batch.values())messages.set(m.id,messageText(m));
  if(batch.size<100)break;
  before=batch.last()!.id;
 }
 // Never replace newer event updates with an older snapshot.
 if((idx.changes.get(t.id)??0)!==revision){queueThreadRefresh(idx,t);return;}
 idx.threads.set(t.id,{thread:t,messages});
 idx.indexed++;
}
function queueThreadRefresh(idx:SearchIndex,t:ThreadChannel) {
 idx.changes.set(t.id,(idx.changes.get(t.id)??0)+1);
 if(idx.pending.has(t.id))return;
 idx.pending.add(t.id);
 void (async()=>{
  try {
   // Coalesce bursts and retry transient Discord failures.
   await refreshIndexedThread(idx,t);
  }catch(error){console.error('Suggestion search index update:',error);}
  finally{idx.pending.delete(t.id);}
 })();
}
export function indexSuggestionMessage(guild:Guild,config:TicketConfig,m:Message) {
 if(m.channel.parentId!==config.suggestionsForumId||!m.channel.isThread())return;
 const idx=indexFor(guild),t=m.channel;
 const entry=idx.threads.get(t.id);
 idx.changes.set(t.id,(idx.changes.get(t.id)??0)+1);
 if(entry){entry.thread=t;entry.messages.set(m.id,messageText(m));}
 else queueThreadRefresh(idx,t);
}
export function invalidateSuggestionThread(guild:Guild,config:TicketConfig,t:ThreadChannel) {
 if(t.parentId!==config.suggestionsForumId)return;
 queueThreadRefresh(indexFor(guild),t);
}
export function removeSuggestionThread(guild:Guild,id:string) {
 const idx=indexFor(guild);idx.changes.set(id,(idx.changes.get(id)??0)+1);idx.threads.delete(id);
}
export async function buildSuggestionIndex(guild:Guild,config:TicketConfig) {
 if(!config.suggestionsForumId)return;
 const idx=indexFor(guild);if(idx.loading)return;
 idx.loading=true;idx.ready=false;
 try {
  const forum=await suggestionForum(guild,config);
  const active=[...(await forum.threads.fetchActive(false)).threads.values()];
  const archived=await archivedThreads(forum,guild);
  const all=[...new Map([...archived,...active].map(t=>[t.id,t])).values()];
  idx.total=all.length;idx.indexed=0;
  let next=0;
  await Promise.all(Array.from({length:Math.min(3,all.length)},async()=>{
   while(next<all.length){
    const t=all[next++]!;
    if(idx.threads.has(t.id)){idx.indexed++;continue;}
    try{await refreshIndexedThread(idx,t);}
    catch(error){console.error('Suggestion search index:',t.id,error);}
   }
  }));
  idx.ready=true;
  console.log(`Suggestion index: ${idx.threads.size}/${idx.total} threads searchable.`);
 }finally{idx.loading=false;}
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
  if(needle) {
   const idx=indexFor(guild);
   source=[...idx.threads.values()].map(v=>v.thread);
  }else if(c.archived===true)source=await archivedThreads(forum,guild);
  else source=[...(await forum.threads.fetchActive(false)).threads.values()];
  let all=source.filter(matches);
  if(needle){
   const idx=indexFor(guild);
   all=all.filter(t=>t.name.toLocaleLowerCase().includes(needle)||
    [...(idx.threads.get(t.id)?.messages.values()??[])].some(text=>text.includes(needle)));
  }
  all.sort(newestActivity);
  threads=all.slice(offset,offset+24);hasMore=offset+24<all.length;cursor=String(offset+24);

  return {messages:[{forumId:forum.id,name:forum.name,guildId:guild.id,tags:forum.availableTags.map(t=>({id:t.id,name:t.name,moderated:t.moderated})),cursor,indexing:needle?indexFor(guild).loading:false,indexed:needle?indexFor(guild).indexed:undefined,total:needle?indexFor(guild).total:undefined},...threads.map(row)],hasMore};
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
  const existing=indexFor(guild).threads.get(updated.id);if(existing)existing.thread=updated;
  return {messages:[row(updated)],hasMore:false};
 }finally{editing.delete(c.channel);}
}
