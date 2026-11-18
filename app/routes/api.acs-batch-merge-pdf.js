import {authenticate} from "../shopify.server";

async function retired({request}) {
  const {cors}=await authenticate.admin(request);
  return cors(Response.json({success:false,message:"Create ACS labels in Courier Label → Prepare orders."},{status:410}));
}
export const loader=retired;
export const action=retired;
