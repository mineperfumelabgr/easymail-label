import {redirect} from "react-router";

export function loader({request}) {
  const url=new URL(request.url);
  url.pathname="/app/geniki-operations";
  url.searchParams.delete("view");
  return redirect(url.pathname+url.search);
}
