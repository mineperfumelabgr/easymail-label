Courier Labels - correzione azione ordine singolo

Questo aggiornamento aggiunge all'azione More actions > Generate ACS Label:
- selezione del dipendente gestita dalla sezione Dipendenti;
- aggiunta del nome del dipendente come tag all'ordine selezionato;
- calendario per Pickup date, con controllo della validità della data.

Prerequisito: l'aggiornamento Dipendenti già installato, con la tabella Employee
e la route /api/employees. Non è richiesta una nuova migrazione del database.

Estrai il contenuto dello ZIP nella root del progetto easymail-label, mantenendo
i percorsi delle cartelle. Poi esegui:

  npm run build && npm run typecheck

Se Shopify CLI è in esecuzione, riavvia la sessione dev e prova l'azione dal
menu More actions di un ordine. Se non esiste alcun dipendente, aggiungilo prima
nella sezione Dipendenti.
