# 🎙️ AI Session Analyzer - Chrome Extension

An intelligent Chrome extension that records meeting audio and generates comprehensive AI-powered session reports using Google's Gemini AI.

## ✨ Features

- 🎤 **Dual Audio Recording**: Captures both tab audio and microphone simultaneously
- 🤖 **AI-Powered Analysis**: Uses Google Gemini to generate structured session reports
- 📊 **Detailed Reports**: Extracts key discussion points, decisions, action items, and more
- 💾 **Session Management**: Store and regenerate analysis for past sessions
- 🌐 **Multi-language Support**: Automatically detects and responds in session language (Persian/English)
- 📝 **Markdown Reports**: Beautiful, formatted reports with emojis and proper structure
- 🔄 **Regenerate Analysis**: Re-analyze any session with improved prompts

## 🏗️ Architecture

### Components

1. **Chrome Extension** (`blue_session_analyzor_extension/`)
   - Popup UI for recording control
   - Service worker for audio capture
   - Report viewer with markdown rendering

2. **Python Backend** (`main.py`)
   - FastAPI server for audio analysis
   - LangChain integration with Google Gemini
   - Session persistence and management

## 🚀 Quick Start

### Prerequisites

- Python 3.8+
- Google Cloud API Key (Gemini API)
- Chrome Browser

### Backend Setup

1. **Clone the repository**
```bash
git clone https://github.com/amirhosseinzolfi/AI-session-analyzor-chrome-extension.git
cd AI-session-analyzor-chrome-extension
```

2. **Create virtual environment**
```bash
python -m venv extension_env
source extension_env/bin/activate  # On Windows: extension_env\Scripts\activate
```

3. **Install dependencies**
```bash
pip install -r requirements.txt
```

4. **Configure environment**
Create a `.env` file:
```env
GOOGLE_API_KEY=your_google_api_key_here
MODEL_ID=gemini-flash-lite-latest
LLM_TIMEOUT=180
MAX_CONCURRENT_ANALYSES=3
```

5. **Run the backend**
```bash
uvicorn main:app --host 0.0.0.0 --port 15306 --reload
```

### Extension Setup

1. **Open Chrome Extensions**
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode"

2. **Load Extension**
   - Click "Load unpacked"
   - Select the `blue_session_analyzor_extension` folder

3. **Configure Backend URL**
   - Update `manifest.json` host_permissions if needed
   - Default: `http://localhost:15306/*`

## 📖 Usage

1. **Start Recording**
   - Click the extension icon
   - Click "Start Recording"
   - Grant tab audio and microphone permissions

2. **Stop & Analyze**
   - Click "Stop Recording"
   - Audio is automatically sent for AI analysis
   - View progress in the extension popup

3. **View Reports**
   - Click on completed session titles
   - Reports open in a new window with formatted markdown

4. **Regenerate Analysis**
   - Click the refresh icon on any session
   - Re-analyze with the same audio

## 🔧 Configuration

### Backend Configuration

Edit `.env` file:

| Variable | Description | Default |
|----------|-------------|---------|
| `GOOGLE_API_KEY` | Google Gemini API key | Required |
| `MODEL_ID` | Gemini model to use | `gemini-flash-lite-latest` |
| `LLM_TIMEOUT` | Analysis timeout (seconds) | `180` |
| `MAX_CONCURRENT_ANALYSES` | Concurrent analysis limit | `3` |

### Extension Configuration

Edit `manifest.json`:

- **host_permissions**: Add your backend server URLs
- **permissions**: Modify required permissions

## 📊 Report Structure

Generated reports include:

- **خلاصه جلسه (Session Summary)**
  - Main topic
  - Participants
  - Duration
  - Importance score
  - Key contributor

- **صورت جلسه (Meeting Minutes)**
  - General notes
  - Per-person contributions
  - Participant ratings

- **اقدامات و تصمیمات (Actions & Decisions)**
  - Team decisions
  - Individual tasks
  - Owners and deadlines

## 🗂️ Project Structure

```
.
├── blue_session_analyzor_extension/  # Chrome extension
│   ├── manifest.json                  # Extension manifest
│   ├── popup.html/js                  # UI components
│   ├── service_worker.js              # Background worker
│   ├── report.html/js                 # Report viewer
│   └── files/                         # Assets
├── main.py                            # FastAPI backend
├── log_config.py                      # Logging configuration
├── requirements.txt                   # Python dependencies
├── .env                               # Environment variables (create this)
└── README.md                          # This file
```

## 🔒 Security Notes

- Never commit `.env` file with API keys
- Store sensitive data in environment variables
- Use HTTPS in production
- Validate all user inputs

## 🐛 Troubleshooting

### Backend Issues

**Port already in use:**
```bash
# Change port in uvicorn command
uvicorn main:app --host 0.0.0.0 --port 15307
```

**API Key errors:**
- Verify `GOOGLE_API_KEY` in `.env`
- Check API key permissions in Google Cloud Console

### Extension Issues

**Recording not starting:**
- Check microphone/tab permissions
- Verify backend is running
- Check browser console for errors

**Analysis failing:**
- Check backend logs in `logs/all_sessions.log`
- Verify audio file size (not too small)
- Check network connectivity

## 📝 API Endpoints

### `POST /analyze_base64`
Analyze audio and generate session report

**Request:**
```json
{
  "session_id": "uuid",
  "mime_type": "audio/webm",
  "audio_base64": "base64_encoded_audio",
  "user_id": "optional_user_id",
  "user_name": "optional_user_name",
  "duration_minutes": 15.5
}
```

**Response:**
```json
{
  "session_id": "uuid",
  "model": "gemini-flash-lite-latest",
  "title": "Session Title",
  "session_report": "# Markdown Report...",
  "status": "ok",
  "processing_time": 12.34
}
```

### `GET /health`
Health check endpoint

### `GET /session_audio/{user_id}/{session_id}`
Retrieve stored session audio

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## 📄 License

This project is open source and available under the MIT License.

## 👤 Author

**Amirhossein Zolfi**
- GitHub: [@amirhosseinzolfi](https://github.com/amirhosseinzolfi)

## 🙏 Acknowledgments

- Google Gemini AI for powerful language models
- LangChain for AI orchestration
- FastAPI for the backend framework

## 📞 Support

For issues and questions:
- Open an issue on GitHub
- Check existing issues for solutions

---

Made with ❤️ by Amirhossein Zolfi
