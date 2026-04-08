"""
桌宠主窗口类
"""
import random
import sys
from PyQt6.QtWidgets import QWidget, QVBoxLayout, QLabel, QApplication
from PyQt6.QtCore import Qt, QPoint, QTimer, QPropertyAnimation, QEasingCurve, pyqtSignal
from PyQt6.QtGui import QPixmap, QMouseEvent, QCursor, QFont

from .speech_bubble import SpeechBubble
from .mood_system import MoodSystem
from .animation_manager import AnimationManager


class PetWindow(QWidget):
    """桌宠主窗口"""
    
    # 信号
    clicked = pyqtSignal()
    mood_changed = pyqtSignal(str)
    
    def __init__(self):
        super().__init__()
        
        # 初始化状态
        self.dragging = False
        self.drag_position = QPoint()
        self.is_idle = True
        
        # 初始化系统
        self.mood_system = MoodSystem()
        self.animation_manager = AnimationManager(self)
        
        # 设置窗口
        self._setup_window()
        self._setup_ui()
        self._setup_timers()
        
        # 连接信号
        self.mood_system.mood_changed.connect(self._on_mood_changed)
        
    def _setup_window(self):
        """设置窗口属性"""
        # 无边框、置顶、透明背景
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.WindowStaysOnTopHint |
            Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        
        # 窗口大小
        self.setFixedSize(150, 150)
        
        # 移动到屏幕中央偏右下
        screen = QApplication.primaryScreen().geometry()
        self.move(screen.width() - 200, screen.height() - 200)
        
    def _setup_ui(self):
        """设置UI组件"""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        
        # 宠物图片标签
        self.pet_label = QLabel(self)
        self.pet_label.setFixedSize(150, 150)
        self.pet_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.pet_label.setCursor(QCursor(Qt.CursorShape.OpenHandCursor))
        
        # 加载默认图片
        self._load_pet_image('idle')
        
        layout.addWidget(self.pet_label)
        
        # 对话气泡（初始隐藏）
        self.speech_bubble = SpeechBubble(self)
        self.speech_bubble.hide()
        
    def _setup_timers(self):
        """设置定时器"""
        # 待机动画定时器
        self.idle_timer = QTimer(self)
        self.idle_timer.timeout.connect(self._play_idle_animation)
        self.idle_timer.start(3000)  # 每3秒检查一次
        
        # 随机说话定时器
        self.talk_timer = QTimer(self)
        self.talk_timer.timeout.connect(self._random_speak)
        self.talk_timer.start(15000)  # 每15秒随机说话
        
        # 心情衰减定时器
        self.mood_decay_timer = QTimer(self)
        self.mood_decay_timer.timeout.connect(self._decay_mood)
        self.mood_decay_timer.start(60000)  # 每分钟衰减
        
    def _load_pet_image(self, state: str):
        """加载宠物图片"""
        import os
        
        # 图片路径映射
        image_map = {
            'idle': 'pet_idle.png',
            'happy': 'pet_happy.png',
            'sad': 'pet_sad.png',
            'sleepy': 'pet_sleepy.png',
            'clicked': 'pet_clicked.png',
            'dragging': 'pet_dragging.png'
        }
        
        image_name = image_map.get(state, 'pet_idle.png')
        image_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)),
            'resources', 'images', image_name
        )
        
        # 如果图片不存在，使用占位符
        if not os.path.exists(image_path):
            # 创建一个简单的彩色圆形作为占位
            from PyQt6.QtGui import QPainter, QColor, QBrush
            pixmap = QPixmap(120, 120)
            pixmap.fill(Qt.GlobalColor.transparent)
            
            painter = QPainter(pixmap)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing)
            
            # 根据状态选择颜色
            colors = {
                'idle': QColor(255, 200, 150),
                'happy': QColor(255, 220, 100),
                'sad': QColor(150, 180, 220),
                'sleepy': QColor(200, 180, 220),
                'clicked': QColor(255, 180, 180),
                'dragging': QColor(180, 255, 200)
            }
            color = colors.get(state, colors['idle'])
            
            painter.setBrush(QBrush(color))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.drawEllipse(10, 10, 100, 100)
            
            # 画眼睛
            painter.setBrush(QBrush(QColor(50, 50, 50)))
            if state == 'sleepy':
                # 闭眼
                painter.drawLine(35, 50, 45, 50)
                painter.drawLine(75, 50, 85, 50)
            else:
                # 睁眼
                painter.drawEllipse(35, 45, 12, 12)
                painter.drawEllipse(75, 45, 12, 12)
            
            # 画嘴巴
            if state == 'happy':
                painter.drawArc(45, 55, 30, 20, 0, -180 * 16)
            elif state == 'sad':
                painter.drawArc(45, 65, 30, 20, 0, 180 * 16)
            else:
                painter.drawEllipse(55, 65, 10, 10)
            
            painter.end()
            self.pet_label.setPixmap(pixmap)
        else:
            pixmap = QPixmap(image_path)
            self.pet_label.setPixmap(pixmap.scaled(
                150, 150,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation
            ))
            
    def _play_idle_animation(self):
        """播放待机动画"""
        if self.is_idle and not self.dragging:
            self.animation_manager.play_breathing()
            
    def _random_speak(self):
        """随机说话"""
        if not self.dragging and self.is_idle:
            text = self.mood_system.get_random_dialogue()
            self.show_speech(text)
            
    def _decay_mood(self):
        """心情自然衰减"""
        self.mood_system.decay_mood()
        
    def _on_mood_changed(self, mood: str):
        """心情变化回调"""
        self.mood_changed.emit(mood)
        self._load_pet_image(mood)
        
    def show_speech(self, text: str, duration: int = 3000):
        """显示对话气泡"""
        self.speech_bubble.set_text(text)
        
        # 计算气泡位置（在宠物上方）
        bubble_x = (self.width() - self.speech_bubble.width()) // 2
        bubble_y = -self.speech_bubble.height() + 10
        self.speech_bubble.move(bubble_x, bubble_y)
        
        self.speech_bubble.show()
        self.speech_bubble.start_hide_timer(duration)
        
    # ===== 鼠标事件处理 =====
    
    def mousePressEvent(self, event: QMouseEvent):
        """鼠标按下"""
        if event.button() == Qt.MouseButton.LeftButton:
            self.dragging = True
            self.drag_position = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            self.is_idle = False
            
            # 更新光标和表情
            self.setCursor(QCursor(Qt.CursorShape.ClosedHandCursor))
            self._load_pet_image('dragging')
            
            # 增加心情
            self.mood_system.interact('pet')
            
            event.accept()
            
    def mouseMoveEvent(self, event: QMouseEvent):
        """鼠标移动（拖拽）"""
        if self.dragging and event.buttons() == Qt.MouseButton.LeftButton:
            new_pos = event.globalPosition().toPoint() - self.drag_position
            self.move(new_pos)
            
            # 隐藏气泡
            self.speech_bubble.hide()
            
            event.accept()
            
    def mouseReleaseEvent(self, event: QMouseEvent):
        """鼠标释放"""
        if event.button() == Qt.MouseButton.LeftButton:
            self.dragging = False
            self.is_idle = True
            
            # 恢复光标和表情
            self.setCursor(QCursor(Qt.CursorShape.OpenHandCursor))
            self._load_pet_image(self.mood_system.current_mood)
            
            # 显示释放台词
            text = self.mood_system.get_dialogue('release')
            self.show_speech(text)
            
            event.accept()
            
    def mouseDoubleClickEvent(self, event: QMouseEvent):
        """双击事件"""
        if event.button() == Qt.MouseButton.LeftButton:
            # 播放点击动画
            self._load_pet_image('clicked')
            self.animation_manager.play_jump()
            
            # 增加心情
            self.mood_system.interact('click')
            
            # 显示台词
            text = self.mood_system.get_dialogue('click')
            self.show_speech(text)
            
            # 恢复表情
            QTimer.singleShot(500, lambda: self._load_pet_image(self.mood_system.current_mood))
            
            event.accept()
