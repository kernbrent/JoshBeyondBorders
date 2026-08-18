# Beyond Borders

Website for Joshua Jacob's England and South Africa music, worship, and service journey. Production address: <https://joshbeyondborders.org>.

For architecture, local development, deployment, Admin Portal, giving-data workflow, and secret-management details, see the branded Microsoft Word guide: [`docs/JoshBeyondBorders-Developer-Operations-Guide.docx`](docs/JoshBeyondBorders-Developer-Operations-Guide.docx).

## Local development

Open `index.html` in a browser or serve the project with a local web server.

## Image naming

Images use `beyond<YYYYMMDD><sequence>` names. Added graphic text is kept in HTML/CSS rather than baked into image files; text naturally photographed in a scene is preserved.

## Branch workflow

`main` is the production branch. Make changes on a separate working branch, review and validate them, then merge into `main` when approved for release. Static hosting behavior is configured outside this repository; follow the verification steps in the developer guide rather than assuming a push is live.
