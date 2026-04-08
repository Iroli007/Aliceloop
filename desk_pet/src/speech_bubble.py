"""
对话气泡组件
"""
from PyQt6.QtWidgets import QWidget, QLabel, QVBoxLayout
from PyQt6.QtCore import Qt, QTimer, QPoint
from PyQt6.QtGui import QPainter, QColor, QBrush, QFont, QPainterPath, QPen


class SpeechBubble(QWidget):
    """对话气泡"""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        
        # 设置窗口属性
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint | Qt.WindowType.Tool)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        
        # 固定大小
        self.setFixedSize(180, 80)
        
        # 创建布局
        layout = QVBoxLayout(self)
        layout.setContentsMargins(15, 10, 15, 20)
        layout.setSpacing(0)
        
        # 文本标签
        self.text_label = QLabel(self)
        self.text_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.text_label.setWordWrap(True)
        self.text_label.setStyleSheet("""
            QLabel {
                color: #333333;
                font-size: 13px;
                font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
                background: transparent;
            }
        """)
        
        layout.addWidget(self.text_label)
        
        # 隐藏定时器
        self.hide_timer = QTimer(self)
        self.hide_timer.setSingleShot(True)
        self.hide_timer.timeout.connect(self.hide)
        
    def set_text(self, text: str):
        """设置文本"""
        self.text_label.setText(text)
        # 根据文本长度调整大小
        text_length = len(text)
        if text_length > 15:
            self.setFixedSize(200, 90)
        elif text_length > 8:
            self.setFixedSize(180, 80)
        else:
            self.setFixedSize(150, 70)
            
    def start_hide_timer(self, duration: int):
        """启动隐藏定时器"""
        self.hide_timer.start(duration)
        
    def paintEvent(self, event):
        """绘制气泡"""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        
        # 气泡颜色
        bg_color = QColor(255, 255, 255, 240)
        border_color = QColor(200, 200, 200, 200)
        
        # 绘制气泡主体（圆角矩形）
        rect = self.rect().adjusted(2, 2, -2, -15)
        
        path = QPainterPath()
        path.addRoundedRect(rect, 15, 15)
        
        # 绘制小三角（指向下方）
        triangle_width = 20
        triangle_height = 15
        center_x = self.width() // 2
        bottom_y = self.height() - 15
        
        path.moveTo(center_x - triangle_width // 2, bottom_y - triangle_height)
        path.lineTo(center_x, bottom_y)
        path.lineTo(center_x + triangle_width // 2, bottom_y - triangle_height)
        path.closeSubpath()
        
        # 填充背景
        painter.fillPath(path, QBrush(bg_color))
        
        # 绘制边框
        pen = QPen(border_color)
        pen.setWidth(2)
        painter.setPen(pen)
        painter.drawPath(path)
        
        painter.end()
