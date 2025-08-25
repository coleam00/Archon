# Coolify Deployment Guide for Archon V2

Esta guía explica cómo desplegar Archon V2 en un VPS usando Coolify con SSL automático y configuración de dominio.

## Problemas Resueltos

✅ **CORS y dominios**: Configuración automática según `DOMAIN` y `PROD`  
✅ **SSL/HTTPS**: Soporte para certificados automáticos de Coolify  
✅ **WebSocket**: Socket.IO configurado para producción  
✅ **Volúmenes**: Eliminados volúmenes de desarrollo que causaban errores  
✅ **PYTHONPATH**: Corregidas importaciones de módulos Python  

## Configuración de Variables de Entorno

### Archivo `.env` para Producción

```bash
# === CONFIGURACIÓN OBLIGATORIA ===
# Supabase Configuration (OBLIGATORIO)
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_KEY=tu-service-role-key-aqui

# === CONFIGURACIÓN DE PRODUCCIÓN ===
# Dominio de producción
DOMAIN=tudominio.com

# Modo producción (habilita CORS específico y SSL)
PROD=true

# URL de la API para el frontend
VITE_API_URL=https://tudominio.com

# === PUERTOS (Coolify los gestiona automáticamente) ===
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
ARCHON_UI_PORT=3737

# === CONFIGURACIÓN OPCIONAL ===
OPENAI_API_KEY=tu-openai-key-opcional
LOGFIRE_TOKEN=tu-logfire-token-opcional
LOG_LEVEL=INFO
```

### Variables para Desarrollo Local

```bash
DOMAIN=localhost
PROD=false
VITE_API_URL=http://localhost:8181
```

## Pasos de Deployment en Coolify

### 1. Preparación en tu VPS

```bash
# Conectar a tu VPS
ssh tu-usuario@tu-vps

# Ir al directorio donde está tu código
cd /path/to/archon-1

# Crear archivo .env con configuración de producción
cp .env.example .env
# Editar .env con tus valores reales
```

### 2. Configuración en Coolify Dashboard

1. **Crear Nuevo Proyecto**
   - Ir a Coolify Dashboard
   - Crear nuevo proyecto → Docker Compose
   - Conectar repositorio Git o subir archivos

2. **Variables de Entorno**
   - Ir a tu proyecto → Environment Variables
   - Agregar todas las variables del archivo `.env`
   - **IMPORTANTE**: Asegúrate de que `DOMAIN=tudominio.com` y `PROD=true`

3. **Configuración de Dominio**
   - Ir a `archon-frontend` service
   - Agregar tu dominio en "Domains"
   - Coolify configurará automáticamente SSL con Let's Encrypt

4. **Deploy**
   - Click "Deploy"
   - Coolify construirá e iniciará todos los servicios

### 3. Verificación del Deployment

```bash
# Verificar que todos los servicios están corriendo
docker ps

# Ver logs si hay problemas
docker-compose logs -f archon-server
docker-compose logs -f archon-frontend
```

## Diferencias entre Desarrollo y Producción

| Aspecto | Desarrollo | Producción |
|---------|------------|------------|
| CORS | Permite `*` | Solo el dominio específico |
| SSL | HTTP | HTTPS automático |
| Frontend | Vite dev server | Vite prod preview |
| API URL | `localhost:8181` | `https://tudominio.com` |
| Volumes | Montados (hot reload) | Sin volumes |

## Arquitectura de Servicios

```
┌─────────────────┐    ┌─────────────────┐
│  archon-frontend│    │  archon-server  │
│   (Nginx/Vite) │◄───┤   (FastAPI)     │
│   Puerto 3737   │    │   Puerto 8181   │
└─────────────────┘    └─────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌─────────────────┐    ┌─────────────────┐   ┌─────────────────┐
│   archon-mcp    │    │ archon-agents   │   │   Supabase      │
│   (MCP Tools)   │    │ (AI Agents)     │   │  (Database)     │
│   Puerto 8051   │    │   Puerto 8052   │   │                 │
└─────────────────┘    └─────────────────┘   └─────────────────┘
```

## Troubleshooting

### Error: "ModuleNotFoundError: No module named 'src.server'"
✅ **Resuelto**: Actualizado PYTHONPATH en todos los Dockerfiles

### Error: "Pre-transform error: Failed to load url /src/index.tsx"
✅ **Resuelto**: Eliminados volume mounts que sobrescribían archivos

### Error: "CORS policy"
✅ **Resuelto**: CORS dinámico basado en `DOMAIN` y `PROD`

### WebSocket connection failed
✅ **Resuelto**: Socket.IO configurado para el dominio específico

## Comandos Útiles

```bash
# Rebuilder solo el frontend
docker-compose build archon-frontend

# Rebuilder todo
docker-compose build

# Ver logs en tiempo real
docker-compose logs -f

# Restart services
docker-compose restart

# Ver status de containers
docker-compose ps
```

## Configuración de DNS

Asegúrate de que tu dominio apunte a la IP de tu VPS:

```
A Record: tudominio.com → IP_DE_TU_VPS
CNAME: www.tudominio.com → tudominio.com
```

## Notas Importantes

- 🔒 **SSL**: Coolify gestiona automáticamente los certificados Let's Encrypt
- 🌐 **Dominio**: Debe estar configurado en DNS antes del deployment
- 🔑 **Service Role Key**: Usa el SERVICE ROLE key de Supabase, NO el anon key
- 📝 **Labels**: Todos los services tienen `coolify.managed=true` para integración
- 🚀 **Hot Reload**: Deshabilitado en producción para mejor rendimiento

Con esta configuración, tu aplicación Archon V2 estará funcionando en producción con SSL automático y configuración de dominio apropiada.