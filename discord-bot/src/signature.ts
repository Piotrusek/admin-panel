import type { Guild } from 'discord.js';
const clean=(value:string)=>value.replace(/[\r\n*_`~<>@\\|]/g,'').slice(0,80);
// "— Name · Rank" footer used for staff replies and webhook-posted suggestions.
// The panel sends actors as "Account name [discordId]"; prefer the server nickname when the member is available.
export async function staffSignature(guild:Guild,actor:string,rank:string):Promise<string> {
 const identity=actor.match(/^(.*) \[([0-9]{17,20})\]$/);
 let displayName=identity?.[1]??actor;
 if(identity){try{displayName=(await guild.members.fetch(identity[2]!)).displayName;}catch{/* Use the account name without the ID if the member is unavailable. */}}
 return `— ${clean(displayName)} · ${clean(rank)}`;
}
