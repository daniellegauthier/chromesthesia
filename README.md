## Sound Visualizer
# Description
Sound Visualizer is an interactive web application that captures real-time audio input and transforms it into a dynamic visual representation. It uses frequency analysis to map sound characteristics to colors and digits, creating a unique and engaging audiovisual experience.

# Features
Real-time audio capture and analysis
Visual representation of sound using colors and digits
Start/Stop functionality for audio capture
Responsive design using Tailwind CSS

# Usage
Click the "Start" button to begin audio capture and visualization.
Speak into your microphone or play audio to see the visual representation.
Scroll up and down to view the history of the visualization.
Click the "Stop" button to halt audio capture.

# Customization
You can customize various aspects of the visualizer:

Adjust matrixWidth and matrixHeight in sketch.js to change the size of the visualization grid.
Modify cellSize to alter the size of individual cells in the grid.
Change maxMatrixRows to adjust the maximum number of historical rows stored.
# Data Mapping
The visualizer uses a CSV file to map frequencies to colors and digits. You can modify this mapping by editing the CSV file located at:

https://hebbkx1anhila5yf.public.blob.vercel-storage.com/la%20matrice%20plus-kIWdKtxESmRNHxPTFbvx6NsPzpBa5O.csv

# Dependencies
p5.js<br>
p5.sound.js<br>
Tailwind CSS<br>

# Browser Compatibility
This application has been tested on modern versions of Chrome, Firefox, and Safari. It requires a browser that supports the Web Audio API.

# Future Enhancements
Add option to export visualization as an image or video
Add scroll in history
Implement more advanced audio analysis features
Add text analysis
Add user-configurable color schemes
Contributing
Contributions are welcome! Please feel free to submit a Pull Request.

# License
This project is open source and available under the GNU Public License.
