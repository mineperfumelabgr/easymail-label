import { Form, useActionData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { authenticateGeniki } from "../services/geniki.server";

export async function action({ request }) {
  await authenticate.admin(request);
  try {
    await authenticateGeniki();
    return { message: "Connected to Geniki's test service." };
  } catch (error) {
    return { message: error.message };
  }
}

export default function Geniki() {
  const result = useActionData();
  const navigation = useNavigation();
  return <s-page heading="Geniki Tachydromiki">
    <s-section heading="Test environment">
      <Form method="post"><button disabled={navigation.state !== "idle"}>Test connection</button></Form>
      {result && <p role="status">{result.message}</p>}
    </s-section>
  </s-page>;
}
