import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { Failure } from './common.js';
export class TicketBridge {
 private socket?:WebSocket;
 private pending=new Map<string,{rows:unknown[];resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 attach(socket:WebSocket) {
  if(this.socket?.readyState===WebSocket.OPEN){socket.close(1008,'Bot already connected');return;}
  this.socket=socket;
  socket.on('message',(data,binary)=>{
   try{
    if(binary||data.toString().length>60000)throw new Error();
    const m=JSON.parse(data.toString()),p=this.pending.get(m.id);if(!p)return;
    if(m.type==='item'){if(p.rows.length>=25)throw new Error();p.rows.push(m.message);return;}
    if(m.type!=='done')throw new Error();
    clearTimeout(p.timer);this.pending.delete(m.id);
    if(m.error){
     const errors:Record<string,[number,string]>={'suggestions-unconfigured':[503,'Set SUGGESTIONS_FORUM_ID in the Discord bot .env and restart it.'],'suggestions-conflict':[409,'This suggestion changed on Discord. Refresh suggestions before saving again.'],'suggestions-readonly':[403,'Editing requires an active, unlocked thread, and the bot needs the Manage Threads permission.'],'suggestions-webhook-unconfigured':[503,'Set SUGGESTIONS_WEBHOOK_URL in the Discord bot .env and restart it.'],'suggestions-webhook-mismatch':[503,'SUGGESTIONS_WEBHOOK_URL must be a webhook of the suggestions forum channel.'],'suggestions-status-unsupported':[409,'This suggestion was not posted by the configured webhook, so its message cannot be edited.'],'suggestions-too-long':[400,'The suggestion text is too long to add a status line.']};
     const [status,message]=errors[String(m.errorCode)]??[502,'Discord request failed. Check bot permissions and refresh before retrying.'];p.reject(new Failure(status,message));
    }
    else p.resolve({messages:p.rows,hasMore:m.hasMore===true});
   }catch{socket.close(1008,'Invalid command response');}
  });
  socket.on('close',()=>{if(this.socket!==socket)return;this.socket=undefined;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Failure(503,'Ticket bot disconnected. Refresh before retrying a reply.'));}this.pending.clear();});
 }
 request(command:Record<string,unknown>):Promise<unknown> {
  const socket=this.socket;if(socket?.readyState!==WebSocket.OPEN)throw new Failure(503,'Ticket bot is offline');
  if(this.pending.size>=20)throw new Failure(503,'Ticket bot is busy');
  const id=randomUUID();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(new Failure(504,'Discord request timed out. Refresh before retrying a reply.'));},20000);
   this.pending.set(id,{rows:[],resolve,reject,timer});
   socket.send(JSON.stringify({...command,id}),error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(new Failure(503,'Ticket bot disconnected'));}});
  });
 }
 close(){this.socket?.terminate();}
}
