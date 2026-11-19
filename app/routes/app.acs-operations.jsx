import {Link,useLoaderData,useSearchParams} from 'react-router';
import {authenticate} from '../shopify.server';
import {loadAcsManualShipments,handleAcsManualShipment} from '../services/acs-manual-shipments.server';
import {loadAcsTagSettings,handleAcsTagSettings} from '../services/acs-tag-settings.server';
import {AcsManualShipmentPanel} from '../components/AcsManualShipmentPanel';
import {AcsTagSettingsPanel} from '../components/AcsTagSettingsPanel';
import '../styles/courier.css';
export async function loader({request}){
  const section=new URL(request.url).searchParams.get('section')==='tags'?'tags':'manual';
  const data=section==='tags'?await loadAcsTagSettings({request}):await loadAcsManualShipments({request});
  return {...data,section};
}
export async function action({request}){
  const form=await request.clone().formData();
  if(form.has('rules'))return handleAcsTagSettings({request});
  if(['manual','print'].includes(form.get('op')))return handleAcsManualShipment({request});
  await authenticate.admin(request);
  return {success:false,message:'Choose a supported ACS operation.'};
}
export default function AcsOperations(){
  const {section,shipments,rules,shop}=useLoaderData();const [params]=useSearchParams();
  const target=part=>{const p=new URLSearchParams([...params].filter(([k])=>['shop','host','embedded'].includes(k)));p.set('section',part);return '/app/acs-operations?'+p;};
  return <main className="courier operations"><header><h1>ACS Operations</h1><p>Create manual shipments and manage the order tags used by tracking synchronization.</p><nav aria-label="ACS operations"><Link to={target('manual')} aria-current={section==='manual'?'page':undefined}>Manual shipments</Link><Link to={target('tags')} aria-current={section==='tags'?'page':undefined}>Order tag settings</Link></nav></header>
    {section==='manual'?<AcsManualShipmentPanel shipments={shipments} action={target('manual')}/>:<AcsTagSettingsPanel initialRules={rules} shop={shop} action={target('tags')}/>}
  </main>;
}
