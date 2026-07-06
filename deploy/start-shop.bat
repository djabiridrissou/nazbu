@echo off
REM Start the Nazbu sidecar next to a running Womola shop server (Windows).
REM Requires Docker Desktop. Womola must already be up (its Mongo running).
setlocal
set HERE=%~dp0
if "%WOMOLA_COMPOSE%"=="" set WOMOLA_COMPOSE=%HERE%..\..\womola_prod\docker-compose.prod.yml

echo Starting Nazbu sidecar...
docker compose -f "%WOMOLA_COMPOSE%" -f "%HERE%docker-compose.nazbu.yml" --env-file "%HERE%nazbu.env" up -d --build nazbu-sidecar
if errorlevel 1 goto :err

echo.
echo Nazbu sidecar is running. Logs:
docker logs -f womola_nazbu
goto :eof

:err
echo.
echo Failed to start. Check that Docker Desktop is running and nazbu.env is filled in.
pause
