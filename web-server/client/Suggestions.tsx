import { useEffect,useRef,useState } from 'react';
import type { Api,Session } from './types';
import { has } from '../src/permissions';
import { TicketConversation } from './TicketConversation';
interface Thread {id:string;name:string;guildId:string;tagIds:string[];archived:boolean;locked:boolean}
interface Meta {name:string;forumId:string;guildId:string;cursor?:string;indexing?:boolean;indexed?:number;total?:number;tags:{id:string;name:string;moderated:boolean}[]}
interface Page {meta:Meta;threads:Thread[];hasMore:boolean}
export function Suggestions({api,session}:{api:Api;session:Session}) {
 const cache=useRef(new Map<string,{page:Page;at:number}>());
 const [loading,setLoading]=useState(false),[pageKey,setPageKey]=useState('');
 const [untagged,setUntagged]=useState(false);
 const [filterTags,setFilterTags]=useState<string[]>([]),[search,setSearch]=useState(''),[query,setQuery]=useState('');
 useEffect(()=>{const timer=setTimeout(()=>setQuery(search.trim()),350);return()=>clearTimeout(timer);},[search]);
 const [page,setPage]=useState<Page|null>(null),[archived,setArchived]=useState(false),[cursor,setCursor]=useState(''),[previous,setPrevious]=useState<string[]>([]),[refresh,setRefresh]=useState(0),[selected,setSelected]=useState<Thread|null>(null),[tags,setTags]=useState<string[]>([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const filterKey=[...filterTags].sort().join(','),key=String(archived)+':'+cursor+':'+filterKey+':'+untagged+':'+query;
 const ready=pageKey===key;
 const searching=query.length>0;
 useEffect(()=>{
  let stopped=false;setSelected(null);setNotice('');setError('');
  const cached=cache.current.get(key);
  if(cached){setPage(cached.page);setPageKey(key);}
  if(cached&&Date.now()-cached.at<30000){setLoading(false);return;}
  setLoading(true);
  void api<Page>('/suggestions?archived='+archived+(cursor?'&cursor='+cursor:'')+(filterKey?'&tags='+filterKey:'')+(untagged?'&untagged=true':'')+(query?'&q='+encodeURIComponent(query):''))
   .then(r=>{if(stopped)return;cache.current.delete(key);cache.current.set(key,{page:r,at:Date.now()});while(cache.current.size>30)cache.current.delete(cache.current.keys().next().value!);setPage(r);setPageKey(key);setError('');})
   .catch(e=>{if(!stopped)setError(e.message);})
   .finally(()=>{if(!stopped)setLoading(false);});
  return()=>{stopped=true;};
 },[api,archived,cursor,refresh,filterKey,key,untagged,query]);

 useEffect(()=>{
  if(!query||!page?.meta.indexing||!ready)return;
  const timer=setTimeout(()=>{cache.current.delete(key);setRefresh(v=>v+1);},2000);
  return()=>clearTimeout(timer);
 },[query,page?.meta.indexing,page?.meta.indexed,key,ready]);
 const visible=page?.threads??[];
 const names=(ids:string[])=>ids.map(id=>page?.meta.tags.find(t=>t.id===id)?.name??'Unknown tag');
 return <section className="card" id="suggestions" aria-busy={loading}><div className="section-header"><div><h2>{page?.meta.name??'Server suggestions'}</h2><p className="muted">Ideas from the community. Review, label, and turn them into work.</p></div><button className="secondary" disabled={busy} onClick={()=>{cache.current.clear();setRefresh(v=>v+1);}}>Refresh suggestions</button></div><div className="filter-tabs">{[false,true].map(v=><button key={String(v)} disabled={busy} className={archived===v?'selected':''} onClick={()=>{setArchived(v);setCursor('');setPrevious([]);}}>{v?'Archived':'Active'}</button>)}</div>
 {error&&<p className="banner error" role="alert">{error}</p>}{notice&&<p className="notice" role="status">{notice}</p>}
 {!page&&!error&&<p className="loading">Loading forum suggestions…</p>}
 {page&&<><div className="suggestion-filters"><input aria-label="Search all suggestions and their messages" placeholder="Search all suggestions and messages…" value={search} onChange={e=>{setSearch(e.target.value);setCursor('');setPrevious([]);}}/><div className="suggestion-filter-tags" aria-label="Filter suggestions by tags"><span>Tags · match all</span><button className={untagged?'selected':''} aria-pressed={untagged} disabled={busy} onClick={()=>{setUntagged(!untagged);setFilterTags([]);setCursor('');setPrevious([]);}}>No tags</button>{page.meta.tags.map(t=><button key={t.id} className={filterTags.includes(t.id)?'selected':''} aria-pressed={filterTags.includes(t.id)} disabled={busy} onClick={()=>{setUntagged(false);setFilterTags(filterTags.includes(t.id)?filterTags.filter(id=>id!==t.id):[...filterTags,t.id]);setCursor('');setPrevious([]);}}>{t.name}</button>)}{(untagged||filterTags.length>0)&&<button className="clear-tags" onClick={()=>{setUntagged(false);setFilterTags([]);setCursor('');setPrevious([]);}}>Clear filters</button>}</div><small className="suggestion-load-status" role="status">{loading?'Updating suggestions… · ':!ready?'Showing previous results · ':''}{searching?(page.meta.indexing?`Indexing suggestions (${page.meta.indexed??0}/${page.meta.total??'…'}) · Results may be incomplete · `:'Searching indexed suggestions · '):'Newest activity first · '}{visible.length} shown on this page{page.hasMore?' · more pages available':''}</small></div><div className="suggestion-grid">{visible.map(t=><button className={'suggestion-card '+(selected?.id===t.id?'selected':'')} key={t.id} disabled={busy||!ready||loading} onClick={()=>{setSelected(t);setTags(t.tagIds);setNotice('');}}><span className="suggestion-row-mark">#</span><strong>{t.name}</strong><span className="ticket-tags">{names(t.tagIds).map((n,i)=><span key={i}>{n}</span>)}</span></button>)}</div>{!visible.length&&<p className="empty">{searching?(page.meta.indexing?'Indexing messages. More results may appear shortly.':'No suggestions match your search.'):'No suggestions match the selected filters.'}{page.hasMore?' Try the next page.':''}</p>}<div className="ticket-pagination"><button className="secondary" disabled={!previous.length||busy||!ready||loading} onClick={()=>{setCursor(previous.at(-1)!);setPrevious(previous.slice(0,-1));}}>Previous</button><button className="secondary" disabled={!page.hasMore||!page.meta.cursor||busy||!ready||loading} onClick={()=>{setPrevious([...previous,cursor]);setCursor(page.meta.cursor!);}}>Next</button></div>
 {selected&&<div className="suggestion-detail"><div className="suggestion-controls"><div><h3>Forum tags</h3><p className="muted">Apply up to five existing tags.</p><div className="suggestion-tag-options">{page.meta.tags.map(t=><label className="checkbox" key={t.id}><input type="checkbox" checked={tags.includes(t.id)} disabled={busy||!has(session,'suggestions.tags')||selected.archived||selected.locked||tags.length>=5&&!tags.includes(t.id)} onChange={e=>setTags(e.target.checked?[...tags,t.id]:tags.filter(id=>id!==t.id))}/>{t.name}</label>)}</div>{(selected.archived||selected.locked)&&<p className="muted">Tag editing is available for active, unlocked threads.</p>}{has(session,'suggestions.tags')&&<button className="primary" disabled={busy||selected.archived||selected.locked} onClick={async()=>{setBusy(true);setError('');try{const result=await api<{messages:Thread[]}>('/suggestions/'+selected.id+'/tags',{tags,expected:selected.tagIds});const updated=result.messages[0]!;cache.current.clear();setSelected(updated);setTags(updated.tagIds);setPage({...page,threads:page.threads.map(t=>t.id===updated.id?updated:t)});setNotice('Forum tags updated.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>Save tags</button>}</div>
 {has(session,'tab.todo')&&has(session,'todo.create')&&<div><h3>Make it happen</h3><p className="muted">Add this idea to the developer board.</p><button className="secondary" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await api('/todos',{title:selected.name,description:'Created from a Discord suggestion.',status:'todo',priority:'normal',assignee:'',source:{id:selected.id,guildId:selected.guildId}});setNotice('Task created. Open To-do to assign and track it.');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>Create task</button></div>}</div>
 <TicketConversation key={selected.id} ticket={{...selected,tags:names(selected.tagIds)}} api={api} apiBase="/suggestions" canReply={has(session,'suggestions.reply')&&!selected.archived&&!selected.locked} onBack={()=>setSelected(null)} readOnlyMessage={selected.archived||selected.locked?'This thread is archived or locked. Reopen it in Discord to reply.':'Your rank needs “Reply to suggestions” to respond.'}/>
 </div>}
 </>}
 </section>;
}
