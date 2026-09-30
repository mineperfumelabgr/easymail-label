import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

function cleanName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeName(value) {
  return cleanName(value).toLocaleLowerCase();
}

function duplicateNameError(error) {
  return error?.code === "P2002";
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const employees = await prisma.employee.findMany({
    where: { shop: session.shop },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return { employees };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const employeeId = String(form.get("employeeId") ?? "");

  try {
    if (intent === "add" || intent === "rename") {
      const name = cleanName(form.get("name"));
      if (!name) return { error: "Inserisci il nome del dipendente." };
      if (name.length > 100) {
        return { error: "Il nome può contenere al massimo 100 caratteri." };
      }

      if (intent === "add") {
        await prisma.employee.create({
          data: {
            shop: session.shop,
            name,
            normalizedName: normalizeName(name),
          },
        });
      } else {
        const updated = await prisma.employee.updateMany({
          where: { id: employeeId, shop: session.shop },
          data: { name, normalizedName: normalizeName(name) },
        });
        if (!updated.count) return { error: "Dipendente non trovato." };
      }

      return redirect("/app/employees");
    }

    if (intent === "delete") {
      const deleted = await prisma.employee.deleteMany({
        where: { id: employeeId, shop: session.shop },
      });
      if (!deleted.count) return { error: "Dipendente non trovato." };
      return redirect("/app/employees");
    }

    return { error: "Operazione non riconosciuta." };
  } catch (error) {
    if (duplicateNameError(error)) {
      return { error: "Esiste già un dipendente con questo nome." };
    }
    console.error("EMPLOYEE MANAGEMENT ERROR:", error);
    return { error: "Non è stato possibile salvare le modifiche." };
  }
}

const inputStyle = {
  boxSizing: "border-box",
  width: "100%",
  minWidth: 0,
  minHeight: 40,
  padding: "8px 12px",
  border: "1px solid #8c9196",
  borderRadius: 8,
  font: "inherit",
};

const buttonStyle = {
  minHeight: 40,
  padding: "8px 14px",
  border: "1px solid #8c9196",
  borderRadius: 8,
  background: "#fff",
  color: "#202223",
  font: "inherit",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export default function EmployeesPage() {
  const { employees } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <s-page heading="Dipendenti">
      <s-section heading="Aggiungi dipendente">
        <s-paragraph>
          Gestisci i nomi disponibili nel batch ACS. Il nome selezionato verrà
          aggiunto come tag Shopify agli ordini elaborati.
        </s-paragraph>
        {actionData?.error ? (
          <s-banner tone="critical">
            <s-text>{actionData.error}</s-text>
          </s-banner>
        ) : null}
        <Form
          method="post"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            alignItems: "end",
            gap: 12,
            marginTop: 16,
          }}
        >
          <input type="hidden" name="intent" value="add" />
          <label style={{ display: "grid", gap: 6, fontWeight: 600 }}>
            Nome
            <input
              name="name"
              type="text"
              autoComplete="off"
              maxLength={100}
              placeholder="Es. Simone"
              style={inputStyle}
              required
            />
          </label>
          <button type="submit" style={buttonStyle} disabled={busy}>
            Aggiungi
          </button>
        </Form>
      </s-section>

      <s-section heading={`Elenco dipendenti (${employees.length})`}>
        {employees.length ? (
          <div style={{ display: "grid", gap: 12 }}>
            {employees.map((employee) => (
              <div
                key={employee.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 12,
                  alignItems: "center",
                  paddingBottom: 12,
                  borderBottom: "1px solid #e1e3e5",
                }}
              >
                <Form
                  method="post"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <input type="hidden" name="intent" value="rename" />
                  <input type="hidden" name="employeeId" value={employee.id} />
                  <input
                    name="name"
                    type="text"
                    aria-label={`Nome dipendente ${employee.name}`}
                    autoComplete="off"
                    maxLength={100}
                    defaultValue={employee.name}
                    style={inputStyle}
                    required
                  />
                  <button type="submit" style={buttonStyle} disabled={busy}>
                    Salva
                  </button>
                </Form>
                <Form
                  method="post"
                  onSubmit={(event) => {
                    if (!window.confirm(`Eliminare ${employee.name}?`)) {
                      event.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="employeeId" value={employee.id} />
                  <button type="submit" style={buttonStyle} disabled={busy}>
                    Elimina
                  </button>
                </Form>
              </div>
            ))}
          </div>
        ) : (
          <s-paragraph>
            Non hai ancora aggiunto dipendenti. Aggiungine almeno uno per
            selezionare il nome nel batch.
          </s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}
