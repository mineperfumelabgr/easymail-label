import db from '../db.server';
import {genikiLive,genikiSandbox,isCourierTestShop} from './geniki.server';
export function validHandoverDate(date,today){
  return /^\d{4}-\d{2}-\d{2}$/.test(date)&&date<=today&&Number.isFinite(Date.parse(date+'T12:00:00Z'))&&new Date(date+'T12:00:00Z').toISOString().slice(0,10)===date;
}
export async function finalizeGenikiDay(shop,date,environment,today){
  if(!validHandoverDate(date,today)||!['live','test'].includes(environment))throw new Error('Choose a valid handover date.');
  if(environment!==(isCourierTestShop(shop)?'test':'live'))throw new Error('Use the environment assigned to this store.');
  const api=environment==='test'?genikiSandbox:genikiLive;
  await api.closeBetween(await api.authenticate(),date+'T00:00:00',date+'T23:59:59.999');
  const finalizedAt=new Date();
  try{
    const record=await db.genikiDailyHandover.upsert({where:{shop_date_environment:{shop,date,environment}},create:{shop,date,environment,finalizedAt},update:{finalizedAt,confirmations:{increment:1}}});
    return {record,messages:[`Geniki accepted the finalization request for ${date} (${environment}). This confirmation does not count newly closed vouchers.`]};
  }catch{
    return {record:{date,environment,finalizedAt,confirmations:1},messages:[`Geniki confirmed finalization for ${date}, but the app could not save the confirmation history. Do not repeat it just to save the history.`]};
  }
}
