# js-mini-api

A JSON REST API written with the plain Node.js `http` module — **zero dependencies**.

## Endpoints
| Method | Path        | Description           |
|--------|-------------|-----------------------|
| GET    | /health     | Health check          |
| GET    | /tasks      | List all tasks        |
| GET    | /tasks/:id  | Get one task          |
| POST   | /tasks      | Create a task         |
| PUT    | /tasks/:id  | Update a task         |
| DELETE | /tasks/:id  | Delete a task         |

## Run
```bash
node server.js
curl localhost:3000/tasks
curl -X POST localhost:3000/tasks -d '{"title":"New task"}'
```
