// Shared with the React client. Authorization never derives from a rank name.
export const PERMISSIONS = ['suggestions.reply', 'tab.todo', 'todo.create', 'todo.edit', 'todo.delete', 'tab.suggestions', 'suggestions.tags', 'suggestions.status', 'suggestions.create', 'suggestions.delete', 'tickets.reply', 'tab.tickets', 'tickets.lost-items-or-airship', 'tickets.other-support', 'tickets.cant-connect-to-the-server', 'tickets.buy-a-shop-plot-at-spawn', 'tickets.stealing-or-grieffing', 'tickets.player-report', 'tickets.report', 'tickets.uncategorized', 'panel.access', 'tab.players', 'tab.overview', 'tab.cases', 'tab.notes', 'tab.security', 'tab.inventory', 'tab.enderChest', 'tab.curios', 'tab.audit', 'access.manage', 'notes.add', 'notes.edit', 'notes.remove', 'punish.warn', 'punish.kick', 'punish.mute', 'punish.ban', 'punish.offense', 'punish.remove', 'punish.revoke'] as const;
export type Permission = typeof PERMISSIONS[number];
export const has = (user:{permissions?:readonly string[]}|null|undefined, permission:string) => !!user?.permissions?.includes(permission);
export function legacyPermissions(role:string, rank=role):string[] {
  if(role==='deny')return [];
  const read=PERMISSIONS.filter(p=>p==='panel.access'||p.startsWith('tab.')&&p!=='tab.audit'&&p!=='tab.tickets'&&p!=='tab.todo'&&p!=='tab.suggestions');
  if(role==='viewer')return [...read];
  if(role==='moderator')return [...read,'notes.add','notes.edit','notes.remove','punish.warn','punish.kick','punish.mute'];
  if(role==='admin')return PERMISSIONS.filter(p=>p!=='access.manage'||['owner','dev'].includes(rank));
  return [];
}
export function mutationPermission(action:string,body:Record<string,unknown>):string {
  if(action==='punish'&&['WARN','KICK','MUTE','BAN','OFFENSE'].includes(String(body.type)))return 'punish.'+String(body.type).toLowerCase();
  return ({revoke:'punish.revoke','remove-punishment':'punish.remove','note-add':'notes.add','note-edit':'notes.edit','note-remove':'notes.remove'} as Record<string,string>)[action]||'invalid';
}
export function filterDetail(value:unknown,user:{permissions?:readonly string[]}):unknown {
  const input=value as Record<string,unknown>, out:Record<string,unknown>={};
  for(const key of ['uuid','name','online','updatedAt'])if(key in input)out[key]=input[key];
  const groups:Record<string,string[]>={overview:['location','playtime','discord','teams','clockin'],cases:['cases','punish'],notes:['notesAvailable','notes'],security:['hasDetections','tsa','ass']};
  for(const [tab,keys] of Object.entries(groups))if(has(user,'tab.'+tab))for(const key of keys)if(key in input)out[key]=input[key];
  const storage=input.storage as Record<string,unknown>|undefined;
  if(storage){const allowed=['inventory','enderChest','curios'].filter(k=>has(user,'tab.'+k));if(allowed.length)out.storage=Object.fromEntries([...allowed,'source','savedAt','capturedAt'].filter(k=>k in storage).map(k=>[k,storage[k]]));}
  return out;
}
export function filterPlayers(value:unknown,user:{permissions?:readonly string[]}):unknown {
  const input=value as Record<string,unknown>;
  return {...input,players:(input.players as Record<string,unknown>[]).map(p=>Object.fromEntries(Object.entries(p).filter(([k])=>['uuid','name','online'].includes(k)||k==='hasDetections'&&has(user,'tab.security'))))};
}

export const PERMISSION_LABELS:Record<Permission,string>={
 'suggestions.reply':'Reply to suggestions',
 'tab.todo':'To-do tab',
 'todo.create':'Create tasks',
 'todo.edit':'Edit tasks and status',
 'todo.delete':'Delete tasks',
 'tab.suggestions':'Suggestions tab',
 'suggestions.tags':'Apply and remove suggestion tags',
 'suggestions.status':'Change suggestion status',
 'suggestions.create':'Add suggestions',
 'suggestions.delete':'Delete suggestions',
 'tickets.reply':'Reply to permitted tickets',
 'tab.tickets':'Tickets tab',
 'tickets.lost-items-or-airship':"Lost Items or Airship tickets",
 'tickets.other-support':"Other Support tickets",
 'tickets.cant-connect-to-the-server':"Can\u2019t Connect to the Server tickets",
 'tickets.buy-a-shop-plot-at-spawn':"Buy a Shop Plot at Spawn tickets",
 'tickets.stealing-or-grieffing':"Stealing or Grieffing tickets",
 'tickets.player-report':"Player Report tickets",
 'tickets.report':"Report tickets",
 'tickets.uncategorized':'Uncategorized tickets',
 'panel.access':'Sign in', 'tab.players':'Players tab', 'tab.overview':'Overview tab',
 'tab.cases':'Punishments tab', 'tab.notes':'Staff notes tab', 'tab.security':'Security tab',
 'tab.inventory':'Inventory tab', 'tab.enderChest':'Ender Chest tab', 'tab.curios':'Curios tab',
 'tab.audit':'Read and export audit log', 'access.manage':'Manage rank permissions',
 'notes.add':'Add staff notes', 'notes.edit':'Edit own staff notes', 'notes.remove':'Remove own staff notes',
 'punish.warn':'Issue warnings', 'punish.kick':'Kick players', 'punish.mute':'Mute players',
 'punish.ban':'Ban players', 'punish.offense':'Issue configured offenses',
 'punish.remove':'Remove direct punishments', 'punish.revoke':'Remove offense cases'
};
