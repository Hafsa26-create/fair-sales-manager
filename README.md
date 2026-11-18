# Fair Sales Manager PWA

A mobile-first Progressive Web App built to help manage sales across multiple jewellery fairs. The app is designed for an owner and employees to record sales from separate devices and keep fair records organized.

## Main app

The application files are in the `Fair-sales-manager/` folder.

- [Open the application source](./Fair-sales-manager/)
- [Read setup instructions](./Fair-sales-manager/README.md)
- [Review the launch and testing checklist](./Fair-sales-manager/LAUNCH_CHECKLIST.md)

## Main capabilities

- Owner and employee sign-in with separate accounts
- Create and manage multiple fairs
- Configure fair-specific product categories and buying prices
- Record sales from an employee's phone
- Owner dashboard with live sales updates
- Employee access is restricted so buying costs, owner expenses, commission and profit reports are not exposed to employees through the intended access rules
- Offline sale entry and later synchronization
- Installable on Android through Chrome

## Technology

- HTML5
- CSS3
- JavaScript
- Supabase Authentication
- Supabase Postgres and Row Level Security (RLS)
- Supabase Realtime
- Progressive Web App (PWA), Service Worker and Web App Manifest
- GitHub Actions for static validation

## Setup

Follow the detailed [setup guide](./Fair-sales-manager/README.md). The app requires a Supabase project and HTTPS hosting.

## Testing status

This repository includes a [launch checklist](./Fair-sales-manager/LAUNCH_CHECKLIST.md). The checklist describes remaining owner/employee acceptance tests and account-level security settings. Do not treat the app as fully release-verified until those tests have passed on real devices.

## Repository structure

```text
fair-sales-manager/
├── .github/
├── Fair-sales-manager/
│   ├── index.html
│   ├── app.js
│   ├── config.js
│   ├── styles.css
│   ├── manifest.webmanifest
│   ├── sw.js
│   ├── README.md
│   └── LAUNCH_CHECKLIST.md
└── scripts/
    └── validate-fair-sales-manager.mjs
```

## Author

Hafsa Akter — [GitHub Profile](https://github.com/Hafsa26-create)
